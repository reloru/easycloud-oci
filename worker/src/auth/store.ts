/**
 * Auth Durable Object: one global instance (idFromName "global") holding users, sign-in codes,
 * sessions and setup ownership in SQLite. Callers pass only hashes of codes and session tokens.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { constantTimeEqual, randomToken } from "./crypto";

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_MS = 60_000;
export const CODE_MAX_PER_HOUR = 5;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const SESSION_RENEW_BELOW_MS = 15 * 24 * 3600_000;
export const SETUPS_PER_DAY = 3;

export type StartResult = { ok: true } | { ok: false; error: "too-soon" | "too-many" };
export type VerifyResult =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; error: "invalid-code" | "expired" | "too-many-attempts" };
export interface SessionUser {
  id: string;
  email: string;
  /** New expiry when the session was renewed by this lookup. */
  renewedUntil?: number;
}

interface CodeRow { code_hash: string; expires_at: number; attempts: number; sent_at: number; window_start: number; window_count: number }

export class Auth extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL, sent_at INTEGER NOT NULL, window_start INTEGER NOT NULL, window_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setups (account_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }

  private one<T>(query: string, ...args: (string | number)[]): T | undefined {
    return this.ctx.storage.sql.exec(query, ...args).toArray()[0] as T | undefined;
  }

  /** Store a new code for this email, enforcing a resend gap and an hourly cap. */
  startEmail(email: string, hash: string, now: number): StartResult {
    const row = this.one<CodeRow>("SELECT * FROM email_codes WHERE email = ?", email);
    let windowStart = now;
    let windowCount = 1;
    if (row) {
      if (now - row.sent_at < CODE_RESEND_MS) return { ok: false, error: "too-soon" };
      if (now - row.window_start < 3600_000) {
        if (row.window_count >= CODE_MAX_PER_HOUR) return { ok: false, error: "too-many" };
        windowStart = row.window_start;
        windowCount = row.window_count + 1;
      }
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO email_codes (email, code_hash, expires_at, attempts, sent_at, window_start, window_count)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
         sent_at = excluded.sent_at, window_start = excluded.window_start, window_count = excluded.window_count`,
      email, hash, now + CODE_TTL_MS, now, windowStart, windowCount,
    );
    return { ok: true };
  }

  /** Check a code; on success consume it, create the user if new, and open a session. */
  verifyEmail(email: string, hash: string, sessionTokenHash: string, now: number): VerifyResult {
    const row = this.one<CodeRow>("SELECT * FROM email_codes WHERE email = ?", email);
    if (!row || row.expires_at <= now) return { ok: false, error: "expired" };
    if (row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, error: "too-many-attempts" };
    if (!constantTimeEqual(row.code_hash, hash)) {
      this.ctx.storage.sql.exec("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?", email);
      return { ok: false, error: row.attempts + 1 >= CODE_MAX_ATTEMPTS ? "too-many-attempts" : "invalid-code" };
    }
    // Keep the row (as used) so the resend gap and hourly cap still apply after a successful sign-in.
    this.ctx.storage.sql.exec("UPDATE email_codes SET code_hash = '', expires_at = 0 WHERE email = ?", email);
    let user = this.one<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = ?", email);
    if (!user) {
      user = { id: randomToken(16), email };
      this.ctx.storage.sql.exec("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", user.id, email, now);
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", sessionTokenHash, user.id, now + SESSION_TTL_MS,
    );
    return { ok: true, user };
  }

  sessionUser(tokenHash: string, now: number): SessionUser | null {
    const row = this.one<{ id: string; email: string; expires_at: number }>(
      "SELECT u.id AS id, u.email AS email, s.expires_at AS expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
      tokenHash,
    );
    if (!row) return null;
    if (row.expires_at <= now) {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
      return null;
    }
    if (row.expires_at - now < SESSION_RENEW_BELOW_MS) {
      const until = now + SESSION_TTL_MS;
      this.ctx.storage.sql.exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", until, tokenHash);
      return { id: row.id, email: row.email, renewedUntil: until };
    }
    return { id: row.id, email: row.email };
  }

  endSession(tokenHash: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  /** Record a new setup for this user unless they already created SETUPS_PER_DAY in the last 24 h. */
  claimSetup(accountId: string, userId: string, now: number): boolean {
    const recent = this.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM setups WHERE user_id = ? AND created_at > ?", userId, now - 24 * 3600_000,
    )!.n;
    if (recent >= SETUPS_PER_DAY) return false;
    this.ctx.storage.sql.exec("INSERT INTO setups (account_id, user_id, created_at) VALUES (?, ?, ?)", accountId, userId, now);
    return true;
  }

  ownerOf(accountId: string): string | null {
    return this.one<{ user_id: string }>("SELECT user_id FROM setups WHERE account_id = ?", accountId)?.user_id ?? null;
  }

  listSetups(userId: string): { id: string; createdAt: number }[] {
    return this.ctx.storage.sql
      .exec("SELECT account_id, created_at FROM setups WHERE user_id = ? ORDER BY created_at DESC", userId)
      .toArray()
      .map((r) => ({ id: r.account_id as string, createdAt: r.created_at as number }));
  }
}

/**
 * Onboarding (M2): the app generates the user's OCI API key pair, the user adds
 * the public key in the Console and pastes the resulting config preview back,
 * and the app verifies access and resolves the home region.
 * Pure logic with injected storage/fetch so it is unit-testable; the Account
 * Durable Object is a thin wrapper around these functions.
 */
import { open, seal } from "./crypto/envelope";
import { OciClient, OciError, type FetchLike } from "./oci/client";
import { parseConfigPreview } from "./oci/config-preview";
import { homeRegion, listAvailabilityDomains } from "./oci/identity";
import { generateApiKey, importSigningKey } from "./oci/keys";

const RECORD = "account";

export interface AccountRecord {
  state: "awaiting-key" | "connected";
  createdAt: string;
  publicPem: string;
  fingerprint: string;
  sealedKey: string;
  tenancy?: string;
  user?: string;
  homeRegion?: string;
  availabilityDomains?: string[];
  connectedAt?: string;
}

export type PublicAccount = Omit<AccountRecord, "sealedKey">;

export interface OnboardingDeps {
  storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> };
  dataKey: CryptoKey;
  accountId: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export type ConnectError =
  | { kind: "unknown-account"; message: string }
  | { kind: "invalid-preview"; message: string; details: string[] }
  | { kind: "fingerprint-mismatch"; message: string }
  | { kind: "not-authenticated"; message: string; opcRequestId: string | null }
  | { kind: "not-authorized"; message: string; opcRequestId: string | null }
  | { kind: "oci-error"; message: string; status: number; code: string; opcRequestId: string | null };

export type ConnectResult =
  | { ok: true; account: PublicAccount }
  | { ok: false; error: ConnectError };

function toPublic({ sealedKey: _sealed, ...rest }: AccountRecord): PublicAccount {
  return rest;
}

export async function createAccount(deps: OnboardingDeps): Promise<PublicAccount> {
  const existing = await deps.storage.get<AccountRecord>(RECORD);
  if (existing) return toPublic(existing);
  const key = await generateApiKey();
  const record: AccountRecord = {
    state: "awaiting-key",
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    publicPem: key.publicPem,
    fingerprint: key.fingerprint,
    sealedKey: await seal(deps.dataKey, key.privatePkcs8, deps.accountId),
  };
  await deps.storage.put(RECORD, record);
  return toPublic(record);
}

export async function getAccount(deps: OnboardingDeps): Promise<PublicAccount | undefined> {
  const record = await deps.storage.get<AccountRecord>(RECORD);
  return record && toPublic(record);
}

export async function connectAccount(deps: OnboardingDeps, previewText: string): Promise<ConnectResult> {
  const record = await deps.storage.get<AccountRecord>(RECORD);
  if (!record) return { ok: false, error: { kind: "unknown-account", message: "This setup link is not recognised. Start again from the home page." } };

  const parsed = parseConfigPreview(previewText);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        kind: "invalid-preview",
        message: "That doesn't look like the full configuration preview. Copy the whole box Oracle shows after you click Add.",
        details: parsed.errors,
      },
    };
  }
  const preview = parsed.value;
  if (preview.fingerprint !== record.fingerprint) {
    return {
      ok: false,
      error: {
        kind: "fingerprint-mismatch",
        message: "That preview belongs to a different API key. Add the key shown in step 1, then copy the preview Oracle shows right after.",
      },
    };
  }

  const client = new OciClient(
    {
      tenancyOcid: preview.tenancy,
      userOcid: preview.user,
      fingerprint: record.fingerprint,
      privateKey: await importSigningKey(await open(deps.dataKey, record.sealedKey, deps.accountId)),
    },
    deps.fetchImpl,
    deps.now,
  );

  let home: string;
  let ads: string[];
  try {
    home = await homeRegion(client, preview.region, preview.tenancy);
    ads = (await listAvailabilityDomains(client, home, preview.tenancy)).map((ad) => ad.name);
  } catch (err) {
    if (!(err instanceof OciError)) throw err;
    if (err.status === 401) {
      return {
        ok: false,
        error: {
          kind: "not-authenticated",
          message: "Oracle didn't accept the key yet. Check that you clicked Add on the key from step 1, wait a minute, and try again.",
          opcRequestId: err.opcRequestId,
        },
      };
    }
    if (err.status === 404 || err.status === 403) {
      return {
        ok: false,
        error: {
          kind: "not-authorized",
          message: "The key works, but this Oracle user isn't allowed to read the account. Add the key to the account's administrator user.",
          opcRequestId: err.opcRequestId,
        },
      };
    }
    return { ok: false, error: { kind: "oci-error", message: err.message, status: err.status, code: err.code, opcRequestId: err.opcRequestId } };
  }

  const connected: AccountRecord = {
    ...record,
    state: "connected",
    tenancy: preview.tenancy,
    user: preview.user,
    homeRegion: home,
    availabilityDomains: ads,
    connectedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await deps.storage.put(RECORD, connected);
  return { ok: true, account: toPublic(connected) };
}

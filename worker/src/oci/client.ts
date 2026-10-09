/**
 * Minimal OCI REST client: signs each request, sends it, and turns OCI error
 * bodies ({ code, message }) into OciError with the opc-request-id that Oracle
 * support asks for.
 */
import { signRequest, type OciCredentials } from "./signer";

export class OciError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly opcRequestId: string | null,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = "OciError";
  }
}

export type FetchLike = (input: Request) => Promise<Response>;

export class OciClient {
  constructor(
    private readonly creds: OciCredentials,
    private readonly fetchImpl: FetchLike = (req) => fetch(req),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const signed = await signRequest(
      { method, url, body: body === undefined ? undefined : JSON.stringify(body) },
      this.creds,
      this.clock(),
    );
    const res = await this.fetchImpl(new Request(url, { method, headers: signed.headers, body: signed.body }));
    const text = await res.text();
    if (!res.ok) {
      let code = "Unknown";
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        code = parsed.code ?? code;
        message = parsed.message ?? message;
      } catch {
        // Non-JSON error body; keep the raw text.
      }
      throw new OciError(res.status, code, message, res.headers.get("opc-request-id"));
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

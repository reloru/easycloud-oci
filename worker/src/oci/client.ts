/**
 * Minimal OCI REST client: signs each request, sends it, and turns OCI error
 * bodies ({ code, message }) into OciError with the opc-request-id that Oracle
 * support asks for.
 */
import { signRequest, type OciCredentials } from "./signer";
import { encodeRfc3986 } from "./url";

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
    return (await this.send<T>(method, url, body)).data;
  }

  /** GET every page of an OCI list operation (follows the opc-next-page header). */
  async listAll<T>(url: string, maxPages = 50): Promise<T[]> {
    const items: T[] = [];
    let page: string | null = null;
    for (let i = 0; i < maxPages; i++) {
      const pageUrl: string = page === null ? url : `${url}${url.includes("?") ? "&" : "?"}page=${encodeRfc3986(page)}`;
      const { data, headers } = await this.send<T[]>("GET", pageUrl);
      if (!Array.isArray(data)) throw new Error(`Expected a JSON array from ${url}`);
      items.push(...data);
      page = headers.get("opc-next-page");
      if (!page) return items;
    }
    throw new Error(`Listing exceeded ${maxPages} pages: ${url}`);
  }

  private async send<T>(method: string, url: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const signed = await signRequest(
      { method, url, body: body === undefined ? undefined : JSON.stringify(body) },
      this.creds,
      this.clock(),
    );
    const res = await this.fetchImpl(new Request(signed.url, { method, headers: signed.headers, body: signed.body }));
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
    return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
  }
}

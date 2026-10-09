import type { Env } from "./env";

export { Account } from "./account";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_PREVIEW_BYTES = 4096;

function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/health") return json({ ok: true });

    if (pathname === "/api/accounts" && request.method === "POST") {
      const id = newAccountId();
      const account = await env.ACCOUNTS.getByName(id).create(id);
      return json({ id, ...account }, 201);
    }

    const match = /^\/api\/accounts\/([^/]+)(\/connect)?$/.exec(pathname);
    if (match) {
      const id = match[1]!;
      if (!ACCOUNT_ID.test(id)) return json({ error: "not-found" }, 404);
      const stub = env.ACCOUNTS.getByName(id);
      if (!match[2] && request.method === "GET") {
        const account = await stub.status(id);
        return account ? json({ id, ...account }) : json({ error: "not-found" }, 404);
      }
      if (match[2] && request.method === "POST") {
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > MAX_PREVIEW_BYTES) return json({ error: "too-large" }, 413);
        let preview: unknown;
        try {
          preview = (JSON.parse(text) as { preview?: unknown }).preview;
        } catch {
          return json({ error: "invalid-json" }, 400);
        }
        if (typeof preview !== "string") return json({ error: "missing-preview" }, 400);
        const result = await stub.connectOci(id, preview);
        return json(result, result.ok ? 200 : 422);
      }
      return json({ error: "method-not-allowed" }, 405);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

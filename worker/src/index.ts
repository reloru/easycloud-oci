export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;

// A Worker that only calls out: the probe the egress enforcement is tested with.
export default {
  async fetch(request: Request): Promise<Response> {
    const target = new URL(request.url).searchParams.get("to");
    if (!target) return new Response("no target", { status: 400 });
    const res = await fetch(target);
    return new Response(await res.text(), { status: res.status });
  },
};

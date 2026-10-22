// The HTTP protocol of the system, written once and shared by both drivers.
// Only the transport (how a Request reaches the system) differs between them.
import type { Outcome, PackInfo, PackSpec, Session } from "./driver";

export type Transport = {
  web(path: string, init?: RequestInit): Promise<Response>;
  mcp(path: string, init?: RequestInit): Promise<Response>;
};

const jsonInit = (method: string, body: unknown, session?: Session | null): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(session ? { authorization: `Bearer ${session.token}` } : {}),
  },
  body: JSON.stringify(body),
});

async function outcome<T>(res: Response, pick: (body: any) => T): Promise<Outcome<T>> {
  const body: any = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (res.ok) return { ok: true, value: pick(body) };
  if (res.status === 404) return { ok: false, refusal: "not-found", detail: body?.error };
  if (res.status === 401) return { ok: false, refusal: "unauthenticated", detail: body?.error ?? body?.detail };
  if (res.status === 400) return { ok: false, refusal: "invalid", detail: body?.error };
  throw new Error(`system error ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
}

export class HttpProtocol {
  /** Build ids the mcp Worker reported; the compatibility run checks the expected one answered. */
  readonly seenBuilds = new Set<string>();
  constructor(private readonly t: Transport) {}

  signIn(idToken: string): Promise<Outcome<Session>> {
    return this.t.web("/auth/signin", jsonInit("POST", { idToken })).then((r) => outcome(r, (b) => b as Session));
  }
  publish(session: Session, pack: PackSpec): Promise<Outcome<PackInfo>> {
    return this.t.web("/packs", jsonInit("POST", pack, session)).then((r) => outcome(r, (b) => b as PackInfo));
  }
  viewPack(session: Session | null, name: string): Promise<Outcome<PackInfo>> {
    return this.t
      .web(`/packs/${encodeURIComponent(name)}`, { headers: session ? { authorization: `Bearer ${session.token}` } : {} })
      .then((r) => outcome(r, (b) => b as PackInfo));
  }
  async downloadArchive(session: Session | null, name: string): Promise<Outcome<string>> {
    const res = await this.t.web(`/packs/${encodeURIComponent(name)}/archive`, { headers: session ? { authorization: `Bearer ${session.token}` } : {} });
    return outcome(res, (b) => String(b));
  }
  async searchAsAgent(query: string): Promise<PackInfo[]> {
    const res = await this.t.mcp(`/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`mcp search failed: ${res.status}`);
    const body = (await res.json()) as { results: PackInfo[]; build: string };
    this.seenBuilds.add(body.build);
    return body.results.map((r) => ({ ...r, visibility: "public" }));
  }
  async searchOnSite(query: string): Promise<PackInfo[]> {
    const res = await this.t.web(`/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`site search failed: ${res.status}`);
    return ((await res.json()) as { results: PackInfo[] }).results.map((r) => ({ ...r, visibility: "public" }));
  }
}

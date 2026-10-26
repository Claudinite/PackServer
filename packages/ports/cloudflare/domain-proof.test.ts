import { describe, expect, it, vi } from "vitest";
import { AUTH_FILE_MAX_BYTES, dohDns, wellKnownPort } from "./domain-proof";

const answering = (...responses: Array<Response | Error>) => {
  const queue = [...responses];
  return vi.fn(async (...args: unknown[]) => {
    void args;
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response("", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};
const urlOf = (fetcher: ReturnType<typeof vi.fn>, call = 0) => String(fetcher.mock.calls[call]![0]);
const initOf = (fetcher: ReturnType<typeof vi.fn>, call = 0) => fetcher.mock.calls[call]![1] as RequestInit;

describe("wellKnownPort (REQ-SCOPE-017)", () => {
  it("fetches exactly https://<host>/.well-known/packserver-auth and never follows a redirect", async () => {
    const fetcher = answering(new Response("tok", { status: 200 }));
    expect(await wellKnownPort(fetcher).authFile("docs.acme.com")).toEqual({ status: "found", body: "tok" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(urlOf(fetcher)).toBe("https://docs.acme.com/.well-known/packserver-auth");
    expect(initOf(fetcher).redirect).toBe("manual");
  });

  it("treats a redirect as absent without a second request", async () => {
    const fetcher = answering(new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
    expect(await wellKnownPort(fetcher).authFile("acme.com")).toEqual({ status: "absent", reason: "redirected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps the body, by declared length and by what actually arrives", async () => {
    const declared = answering(new Response("x", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }));
    expect(await wellKnownPort(declared).authFile("acme.com")).toEqual({ status: "absent", reason: "too_large" });
    const streamed = answering(new Response("x".repeat(AUTH_FILE_MAX_BYTES + 1), { status: 200 }));
    expect(await wellKnownPort(streamed).authFile("acme.com")).toEqual({ status: "absent", reason: "too_large" });
    const exact = answering(new Response("x".repeat(AUTH_FILE_MAX_BYTES), { status: 200 }));
    expect(await wellKnownPort(exact).authFile("acme.com")).toMatchObject({ status: "found" });
  });

  it("distinguishes a missing file from an unreachable host and refuses anything that is not a bare host", async () => {
    expect(await wellKnownPort(answering(new Response("", { status: 404 }))).authFile("acme.com")).toEqual({ status: "absent", reason: "not_found" });
    expect(await wellKnownPort(answering(new Error("boom"))).authFile("acme.com")).toEqual({ status: "absent", reason: "unreachable" });
    expect(await wellKnownPort(answering(new Response("", { status: 500 }))).authFile("acme.com")).toEqual({ status: "absent", reason: "unreachable" });
    const fetcher = answering();
    for (const host of ["acme.com/evil", "user@acme.com", "acme.com:8443", "127.0.0.1", "localhost", "acme.com?x=1", ""]) {
      expect(await wellKnownPort(fetcher).authFile(host)).toEqual({ status: "absent", reason: "unreachable" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("dohDns", () => {
  const doh = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

  it("asks for the TXT records of the name and joins the quoted chunks of one value", async () => {
    const fetcher = answering(doh({ Status: 0, Answer: [{ type: 16, data: '"packserver-" "abc"' }, { type: 1, data: "1.2.3.4" }, { type: 16, data: '"other"' }] }));
    expect(await dohDns(fetcher).resolveTxt("_packserver-challenge.acme.com")).toEqual(["packserver-abc", "other"]);
    const url = new URL(urlOf(fetcher));
    expect([url.origin + url.pathname, url.searchParams.get("name"), url.searchParams.get("type")]).toEqual(["https://cloudflare-dns.com/dns-query", "_packserver-challenge.acme.com", "TXT"]);
  });

  it("reads NXDOMAIN and an empty answer as no record, and any other failure as an outage", async () => {
    expect(await dohDns(answering(doh({ Status: 3 }))).resolveTxt("a.example")).toEqual([]);
    expect(await dohDns(answering(doh({ Status: 0 }))).resolveTxt("a.example")).toEqual([]);
    await expect(dohDns(answering(doh({ Status: 2 }))).resolveTxt("a.example")).rejects.toMatchObject({ code: "dns_unavailable" });
    await expect(dohDns(answering(doh({}, 503))).resolveTxt("a.example")).rejects.toMatchObject({ code: "dns_unavailable" });
  });
});

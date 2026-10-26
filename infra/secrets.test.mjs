import { describe, expect, it } from "vitest";
import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import { kidFor, nextKid, main, generateSigningKey, setGithubSecret } from "./secrets.mjs";

function fakeCloudflare({ existing = [], failList = false, failCreateOn, accounts = [{ id: "acct" }], flaky = 0, networkFlaky = 0 } = {}) {
  let flakyLeft = flaky;
  let netLeft = networkFlaky;
  const calls = [];
  const created = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (netLeft > 0 && init.method === "POST") {
      netLeft--;
      throw new Error("socket hang up");
    }
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith("/client/v4/accounts")) return json(200, { success: true, result: accounts });
    if (url.endsWith("/secrets_store/stores")) return json(200, { success: true, result: [{ id: "store1", name: "default" }] });
    if (url.includes("/secrets?page=")) {
      if (failList) return json(500, { success: false, errors: [{ code: 1, message: "boom" }] });
      return json(200, { success: true, result: existing.map((name) => ({ name })), result_info: { total_pages: 1 } });
    }
    if (init.method === "POST") {
      if (flakyLeft > 0) {
        flakyLeft--;
        return json(503, { success: false, errors: [{ code: 3, message: "unavailable" }] });
      }
      const [item] = JSON.parse(init.body);
      if (item.name === failCreateOn) return json(500, { success: false, errors: [{ code: 2, message: "nope" }] });
      created.push(item);
      return json(200, { success: true, result: [] });
    }
    return json(404, { success: false, errors: [] });
  };
  return { fetch, calls, created };
}

const run = async (argv, env = {}, deps = {}) => {
  const out = [];
  const err = [];
  const code = await main(argv, env, { sleep: async () => {}, out: (s) => out.push(s), err: (s) => err.push(s), now: () => new Date("2026-11-05T00:00:00Z"), ...deps });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const ENV = { CF_BOOTSTRAP_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acct" };
const TOKEN_ONLY = { CF_BOOTSTRAP_TOKEN: "t" };

describe("kid helpers", () => {
  it("formats the month and rolls the year", () => {
    expect(kidFor(new Date("2026-11-05T00:00:00Z"))).toBe("2026-11");
    expect(nextKid("2026-11")).toBe("2026-12");
    expect(nextKid("2026-12")).toBe("2027-01");
  });
});

describe("secrets.mjs", () => {
  it("prints usage on --help", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: node infra/secrets.mjs");
  });

  it("refuses without --env, with a bad env, and with a bad kid", async () => {
    expect((await run([], ENV)).code).toBe(2);
    expect((await run(["--env", "prod"], ENV)).code).toBe(2);
    expect((await run(["--env", "staging", "--kid", "2026-13"], ENV)).code).toBe(2);
  });

  it("looks the account up when only the token is set and it sees one account", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "production"], TOKEN_ONLY, { fetch: cf.fetch });
    expect(r.code).toBe(0);
    expect(cf.calls.some((c) => c.includes("/accounts/acct/secrets_store/"))).toBe(true);
  });

  it("exits 2 naming CLOUDFLARE_ACCOUNT_ID when the token sees several accounts or none", async () => {
    for (const accounts of [[{ id: "a" }, { id: "b" }], []]) {
      const cf = fakeCloudflare({ accounts });
      const r = await run(["--env", "production"], TOKEN_ONLY, { fetch: cf.fetch });
      expect(r.code).toBe(2);
      expect(r.err).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(cf.created).toEqual([]);
    }
  });

  it("retries a 5xx and a dropped connection with backoff, then succeeds", async () => {
    const cf = fakeCloudflare({ flaky: 1, networkFlaky: 1 });
    const r = await run(["--env", "production"], ENV, { fetch: cf.fetch });
    expect(r.code).toBe(0);
    expect(cf.created).toHaveLength(6);
  });

  it("refuses without Cloudflare credentials and makes no call", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "staging"], {}, { fetch: cf.fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain("CF_BOOTSTRAP_TOKEN");
    expect(cf.calls).toEqual([]);
  });

  it("copies the new self-test key to the GitHub environment when asked, without printing it", async () => {
    const cf = fakeCloudflare();
    const sent = [];
    const r = await run(["--env", "staging", "--set-github-secret"], ENV, { fetch: cf.fetch, setGithubSecret: (x) => sent.push(x) });
    expect(r.code).toBe(0);
    const stored = cf.created.find((c) => c.name === "STAGING_SELFTEST_HMAC_KEY");
    expect(sent).toEqual([{ environment: "staging", name: "SELFTEST_HMAC_KEY", value: stored.value }]);
    expect(r.out + r.err).not.toContain(stored.value);
    expect(r.out).toContain("set GitHub environment secret SELFTEST_HMAC_KEY in staging");
  });

  it("tells the person to delete the stored key and re-run when gh fails, since the value is gone", () => {
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(() => setGithubSecret({ environment: "staging", name: "SELFTEST_HMAC_KEY", value: "v" })).toThrow(/delete SELFTEST_HMAC_KEY from Secrets Store and re-run/);
    } finally {
      process.env.PATH = path;
    }
  });

  it("says so when the self-test key has no GitHub copy, and does not claim one for a key it cannot read back", async () => {
    const without = await run(["--env", "production"], ENV, { fetch: fakeCloudflare().fetch });
    expect(without.out).toContain("--set-github-secret");
    const sent = [];
    const kept = await run(["--env", "production", "--set-github-secret", "--skip-existing"], ENV, { fetch: fakeCloudflare({ existing: ["SELFTEST_HMAC_KEY"] }).fetch, setGithubSecret: (x) => sent.push(x) });
    expect(sent).toEqual([]);
    expect(kept.err).toContain("cannot be read back");
  });

  it("dry-run lists names and needs neither env nor network", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "staging", "--dry-run"], {}, { fetch: cf.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain("STAGING_REGISTRY_SIGNING_KEY_2026_11");
    expect(r.out).toContain("STAGING_REGISTRY_SIGNING_KEY_2026_12");
    expect(r.out).toContain("STAGING_SELFTEST_HMAC_KEY");
    expect(cf.calls).toEqual([]);
  });

  it("uploads six workers-scoped secrets and prints only public halves", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "production"], ENV, { fetch: cf.fetch });
    expect(r.code).toBe(0);
    expect(cf.created.map((c) => c.name)).toEqual([
      "REGISTRY_SIGNING_KEY_2026_11",
      "REGISTRY_SIGNING_KEY_2026_12",
      "SELFTEST_HMAC_KEY",
      "IP_HASH_MASTER_KEY",
      "PRINCIPAL_HASH_KEY",
      "ADMIN_FLAG_HMAC_KEY",
    ]);
    for (const c of cf.created) expect(c.scopes).toEqual(["workers"]);
    const shown = r.out + r.err;
    for (const c of cf.created) expect(shown).not.toContain(c.value);
    expect(r.out).toContain("active  kid=2026-11");
    expect(r.out).toContain("standby kid=2026-12");
  });

  it("the stored private half matches the printed public half", async () => {
    const cf = fakeCloudflare();
    const r = await run(["--env", "production"], ENV, { fetch: cf.fetch });
    const pub = /active {2}kid=2026-11 public_key\(raw, base64url\)=(\S+)/.exec(r.out)[1];
    const priv = createPrivateKey({ key: Buffer.from(cf.created[0].value, "base64"), format: "der", type: "pkcs8" });
    const pubKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" });
    const sig = sign(null, Buffer.from("m"), priv);
    expect(verify(null, Buffer.from("m"), pubKey, sig)).toBe(true);
  });

  it("generates distinct keys each call", () => {
    expect(generateSigningKey().publicRaw).not.toBe(generateSigningKey().publicRaw);
  });

  it("aborts before writing when a name exists, unless --skip-existing", async () => {
    const cf = fakeCloudflare({ existing: ["SELFTEST_HMAC_KEY"] });
    const r = await run(["--env", "production"], ENV, { fetch: cf.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("SELFTEST_HMAC_KEY");
    expect(cf.created).toEqual([]);

    const cf2 = fakeCloudflare({ existing: ["SELFTEST_HMAC_KEY"] });
    const r2 = await run(["--env", "production", "--skip-existing"], ENV, { fetch: cf2.fetch });
    expect(r2.code).toBe(0);
    expect(cf2.created.map((c) => c.name)).not.toContain("SELFTEST_HMAC_KEY");
    expect(cf2.created).toHaveLength(5);
  });

  it("treats a failed listing as an error, never as absent", async () => {
    const cf = fakeCloudflare({ failList: true });
    const r = await run(["--env", "production"], ENV, { fetch: cf.fetch });
    expect(r.code).toBe(1);
    expect(cf.created).toEqual([]);
  });

  it("shows the active public half even when a later upload fails", async () => {
    const cf = fakeCloudflare({ failCreateOn: "SELFTEST_HMAC_KEY" });
    const r = await run(["--env", "production"], ENV, { fetch: cf.fetch });
    expect(r.code).toBe(1);
    expect(r.out).toContain("active  kid=2026-11");
    expect(r.out).toContain("standby kid=2026-12");
  });
});

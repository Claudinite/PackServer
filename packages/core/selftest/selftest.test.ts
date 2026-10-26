import { describe, expect, it } from "vitest";
import { isContractMigration, judgeSchemaHead, parseSelfTestSignature, schemaCheckName, signSelfTest, verifySelfTestSignature } from "./index";

const NOW = 1_800_000_000_000;
const base = { key: "k-secret", keyId: "1", method: "GET", host: "registry.test", path: "/__selftest", nowMs: NOW, nonce: "nonce-0001" };
const verify = (header: string, over: Partial<Parameters<typeof verifySelfTestSignature>[0]> = {}) =>
  verifySelfTestSignature({ header, key: base.key, method: base.method, host: base.host, path: base.path, nowMs: NOW, ...over });

describe("X-Selftest-Signature (release.md candidate gating)", () => {
  it("round-trips and names the key id and nonce", async () => {
    const header = await signSelfTest(base);
    expect(header).toMatch(/^t=1800000000, n=nonce-0001, k=1, v1=[0-9a-f]{64}$/);
    expect(await verify(header)).toEqual({ ok: true, keyId: "1", nonce: "nonce-0001" });
  });

  it("covers the method, host, path, nonce and key id but not the query", async () => {
    const header = await signSelfTest(base);
    expect(await verify(header, { method: "POST" })).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(header, { path: "/other" })).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(header, { host: "other.test" })).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(header.replace("k=1", "k=2"))).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(header.replace("nonce-0001", "nonce-0002"))).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(header, { key: "another" })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("accepts five minutes either way and refuses beyond", async () => {
    const header = await signSelfTest(base);
    expect((await verify(header, { nowMs: NOW + 300_000 })).ok).toBe(true);
    expect((await verify(header, { nowMs: NOW - 300_000 })).ok).toBe(true);
    expect(await verify(header, { nowMs: NOW + 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(await verify(header, { nowMs: NOW - 301_000 })).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses an absent, partial, repeated or padded header", async () => {
    const good = await signSelfTest(base);
    expect(await verify("")).toEqual({ ok: false, reason: "absent" });
    for (const bad of ["garbage", good.replace(/, v1=.*/, ""), `${good}, t=1`, `${good}, x=1`, good.replace("k=1", "k=a b"), good.replace(/v1=[0-9a-f]/, "v1=Z")]) {
      expect(parseSelfTestSignature(bad), bad).toBeNull();
    }
  });
});

const range = { min: "20261026000000", max: "20261026100000" };
describe("IT-OPS-011 schema range", () => {
  it("accepts a head inside the range", () => {
    expect(judgeSchemaHead(["20261025000000_a_b.sql", "20261026000000_a_c.sql", "20261026100000_a_d.sql"], range)).toEqual({ ok: true, head: "20261026100000" });
    expect(judgeSchemaHead(["20261026050000_a_b.sql"], range).ok).toBe(true);
  });

  it("refuses a head below the range and names it", () => {
    expect(judgeSchemaHead(["20261025000000_a_b.sql"], range)).toEqual({ ok: false, head: "20261025000000", why: "below-min" });
    expect(schemaCheckName("20261025000000", range)).toBe("d1.schema head=20261025000000 range=20261026000000..20261026100000");
  });

  it("serves a database one expand ahead and refuses one that holds a contract past the range", () => {
    const ahead = ["20261026100000_a_d.sql", "20261027000000_search_new_column.sql"];
    expect(judgeSchemaHead(ahead, range)).toEqual({ ok: true, head: "20261027000000" });
    expect(judgeSchemaHead([...ahead, "20261028000000_search_contract_drop_old.sql"], range)).toEqual({ ok: false, head: "20261028000000", why: "contract-beyond-max" });
  });

  it("does not count a contract inside the range against the build", () => {
    expect(judgeSchemaHead(["20261026050000_search_contract_drop_old.sql", "20261026100000_a_d.sql"], range).ok).toBe(true);
  });

  it("refuses a database whose migrations cannot be read", () => {
    expect(judgeSchemaHead([], range)).toEqual({ ok: false, head: null, why: "unknown" });
    expect(judgeSchemaHead(["junk.sql"], range).ok).toBe(false);
  });

  it("recognises a contract by its name and not by an area called contracts", () => {
    expect(isContractMigration("20261026000000_search_contract_drop.sql")).toBe(true);
    expect(isContractMigration("20261026000000_search_contract.sql")).toBe(true);
    expect(isContractMigration("20261026000000_search_old_contract.sql")).toBe(true);
    expect(isContractMigration("20261026000000_contracts_table.sql")).toBe(false);
    expect(isContractMigration("20261026000000_search_subcontract.sql")).toBe(false);
  });
});

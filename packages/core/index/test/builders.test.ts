import { describe, expect, it } from "vitest";
import { buildPrivateEntry, buildRoot, buildScopeIndex, buildVersionsDocument, latestEligible, nextSerial, selectListedVersions } from "../index";
import { NOW, minusDays, privateVersion, version } from "./fixtures";

const v = (n: number, over = {}) => version(`1.${n}.0`, over);

describe("scope index version selection (IT-DELIV-003, ARCH-REV M11)", () => {
  it("lists the newest 20 eligible versions of a 25-version pack and leaves the rest to versions.json", () => {
    const versions = Array.from({ length: 25 }, (_, i) => v(i + 1));
    const listed = selectListedVersions({ name: "@acme/big", versions }, NOW);
    expect(listed).toHaveLength(20);
    expect(listed[0]?.version).toBe("1.25.0");
    expect(listed.at(-1)?.version).toBe("1.6.0");

    const scope = buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [{ name: "@acme/big", versions }] });
    expect(scope.packs[0]?.versions).toHaveLength(20);
    const full = buildVersionsDocument({ serial: 1, now: NOW, pack: { name: "@acme/big", versions } });
    expect(full.versions).toHaveLength(25);
  });

  it("keeps a version yanked 179 days ago in the scope index and drops one yanked 181 days ago to versions.json only", () => {
    const versions = [
      ...Array.from({ length: 22 }, (_, i) => v(i + 10)),
      v(1, { status: "yanked", reason: "bad", status_changed_at: minusDays(181) }),
      v(2, { status: "yanked", reason: "bad", status_changed_at: minusDays(179) }),
    ];
    const listed = selectListedVersions({ name: "@acme/big", versions }, NOW).map((x) => x.version);
    expect(listed).toContain("1.2.0");
    expect(listed).not.toContain("1.1.0");
    const full = buildVersionsDocument({ serial: 1, now: NOW, pack: { name: "@acme/big", versions } });
    expect(full.versions.map((x) => x.version)).toContain("1.1.0");
  });

  it("yanked versions do not use up the 20 eligible seats", () => {
    const versions = [...Array.from({ length: 20 }, (_, i) => v(i + 1)), v(30, { status: "yanked", reason: "bad", status_changed_at: minusDays(1) })];
    const listed = selectListedVersions({ name: "@acme/x", versions }, NOW).map((x) => x.version);
    expect(listed).toHaveLength(21);
    expect(listed).toContain("1.1.0");
  });

  it("refuses a non-active version with no status_changed_at and a duplicated version", () => {
    expect(() => selectListedVersions({ name: "@acme/x", versions: [v(1, { status: "yanked", reason: "r" })] }, NOW)).toThrow();
    expect(() => selectListedVersions({ name: "@acme/x", versions: [v(1), v(1)] }, NOW)).toThrow();
  });

  it("does not leak status_changed_at into the signed entry", () => {
    const scope = buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [{ name: "@acme/x", versions: [v(1)] }] });
    expect(JSON.stringify(scope)).not.toContain("status_changed_at");
  });
});

describe("latest_eligible (REQ-DELIV-005)", () => {
  it("never names a yanked, quarantined, removed or revoked version, and comes back when un-yanked", () => {
    const base = [v(0), v(1, { status: "removed", reason: "r", status_changed_at: "x" }), v(2, { status: "quarantined", reason: "r" }), v(3, { status: "yanked", reason: "r" })];
    expect(latestEligible(base)).toBe("1.0.0");
    expect(latestEligible([...base, v(4, { status: "revoked", reason: "r", security: "s" })])).toBe("1.0.0");
    expect(latestEligible([...base.slice(0, 3), v(3)])).toBe("1.3.0");
  });

  it("allows a deprecated version to be newest, and is null when nothing is eligible", () => {
    expect(latestEligible([v(1), v(2, { status: "deprecated", reason: "r" })])).toBe("1.2.0");
    expect(latestEligible([v(1, { status: "yanked", reason: "r" })])).toBeNull();
  });

  it("orders by semver precedence, not lexically", () => {
    expect(latestEligible([version("1.9.0"), version("1.10.0")])).toBe("1.10.0");
  });
});

describe("every status and every per-version field reaches the index", () => {
  it("carries all six statuses, reasons, security, verification facts and the preinstall manifest", () => {
    const old = minusDays(5);
    const versions = [
      v(1),
      v(2, { status: "deprecated", reason: "old", status_changed_at: old }),
      v(3, { status: "yanked", reason: "bad", status_changed_at: old }),
      v(4, { status: "quarantined", reason: "scan", status_changed_at: old }),
      v(5, { status: "revoked", reason: "cve", security: "CVE-1", status_changed_at: old }),
      v(6, { status: "removed", reason: "gone", status_changed_at: old }),
    ];
    const scope = buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [{ name: "@acme/x", versions }] });
    const out = scope.packs[0]!.versions;
    expect(out.map((x) => x.status).sort()).toEqual(["active", "deprecated", "quarantined", "removed", "revoked", "yanked"]);
    expect(out.find((x) => x.status === "revoked")).toMatchObject({ security: "CVE-1", reason: "cve", verified: true, verified_domain: "acme.com", source_verified: true });
    expect(out[0]).toHaveProperty("preinstall.guards");
    expect(out[0]).toHaveProperty("min_engine_version", "1.0.0");
    expect(scope.packs[0]?.latest_eligible).toBe("1.2.0");
  });

  it("refuses an entry the schema refuses: revoked without a security reason", () => {
    expect(() =>
      buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [{ name: "@acme/x", versions: [v(1, { status: "revoked", reason: "r", status_changed_at: minusDays(1) })] }] }),
    ).toThrow();
  });

  it("keeps a removed pack listed with status removed and no latest_eligible", () => {
    const scope = buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [{ name: "@acme/x", removed: true, versions: [v(1, { status: "removed", reason: "r", status_changed_at: minusDays(1) })] }] });
    expect(scope.packs[0]).toMatchObject({ status: "removed", latest_eligible: null });
  });

  it("refuses a pack outside the scope", () => {
    expect(() => buildScopeIndex({ scope: "acme", serial: 1, now: NOW, packs: [{ name: "@other/x", versions: [v(1)] }] })).toThrow();
  });
});

describe("root and private entries", () => {
  it("sorts scopes for determinism and refuses a repeated one", () => {
    const s = { sha256: "a".repeat(64), serial: 1 };
    const root = buildRoot({ serial: 1, now: NOW, scopes: [{ scope: "zed", ...s }, { scope: "acme", ...s }] });
    expect(root.scopes.map((x) => x.scope)).toEqual(["acme", "zed"]);
    expect(() => buildRoot({ serial: 1, now: NOW, scopes: [{ scope: "acme", ...s }, { scope: "acme", ...s }] })).toThrow();
  });

  it("builds a private entry with kind private, the pack and opaque version ids, never a scope or root shape", () => {
    const entry = buildPrivateEntry({ serial: 2, now: NOW, pack: "@acme/secret", versions: [privateVersion("1.0.0", "opq_a"), privateVersion("1.1.0", "opq_b")] });
    expect(entry).toMatchObject({ kind: "private", pack: "@acme/secret", serial: 2 });
    expect(entry.versions.map((x) => x.version_id)).toEqual(["opq_b", "opq_a"]);
    expect(() => buildPrivateEntry({ serial: 2, now: NOW, pack: "@acme/secret", versions: [privateVersion("1.0.0", "opq_a"), privateVersion("1.1.0", "opq_a")] })).toThrow();
  });

  it("nextSerial starts at 1 and only increases", () => {
    expect(nextSerial(null)).toBe(1);
    expect(nextSerial(41)).toBe(42);
  });
});

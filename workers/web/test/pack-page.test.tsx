import { migratedD1 } from "@packserver/core/identity/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import type { D1 } from "@packserver/ports";
import { describe, expect, it } from "vitest";
import { Head } from "../src/pages/pack/components";
import type { PackData } from "../src/pages/pack/data";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";
import { fileAnchor, sectionsOf } from "../src/pages/pack/sections";
import { partOf } from "../src/routes/packs/contents";

const SHA = "a".repeat(64);
const UPLOAD = "b".repeat(64);
const PUBLISHED = "2026-10-22T10:00:00.000Z";
const NAME = "@acme/gcp";
const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const OIDC = { source: "oidc", repository: "acme/packs", repository_id: 1, commit: "c".repeat(40), ref: "refs/tags/v1", event: "push", workflow_run: "1", path: "packs/gcp", source_verified: true };
const preinstall = (extra: Record<string, unknown> = {}) => ({ guards: [], tasks: [], forced_skills: [], github_actions: [], new: [], ...extra });
const inventory = (counts: Record<string, number> = {}) =>
  Object.fromEntries(["skills", "rules", "checks", "guards", "tasks", "env-setup", "forced-skills", "github-actions"].map((p) => [p, { count: counts[p] ?? 0, names: [], tokens: null }]));

function meta(version: string, over: Record<string, unknown> = {}) {
  return {
    pack: NAME, version, inventory: inventory({ skills: 2, guards: 1 }), capabilities: ["guard"], preinstall: preinstall({ guards: [{ name: "no-secrets", tool_calls: ["Bash"] }] }),
    url_inventory: [],
    score: { total: 72, parts: [{ part: "context_cost", weight: 20, points: 13, rules: [{ rule: "context-cost.always-loaded", points: 4, max: 13 }, { rule: "context-cost.skill-body-lines", points: 5, max: 6 }] }], cap: null },
    rules_version: "2026.10.1", verification: { verified: true, verified_domain: "acme.com", verified_github_org: null, source_verified: false },
    provenance: { source: "upload", source_verified: false },
    diff_summary: { previous_version: null, files_added: 0, files_removed: 0, files_changed: 0, new_capabilities: [] }, ...over,
  };
}
const attestation = (version: string) => ({ pack: NAME, version, upload_sha256: UPLOAD, canonical_sha256: SHA, provenance: { source: "upload", source_verified: false }, rules_version: "2026.10.1", validated_at: PUBLISHED, kid: "2026-10" });
const record = (version: string, status: string, over: Record<string, unknown> = {}) => ({
  version, sha256: SHA, size: 5, published_at: PUBLISHED, status, ...(status === "active" ? {} : { reason: "because" }), ...(status === "revoked" ? { security: "tokens leaked" } : {}), min_engine_version: "1.0.0", requires: [],
  source_commit: null, preinstall: preinstall(), verified: true, verified_domain: "acme.com", verified_github_org: null, source_verified: false, ...over,
});

interface Seed {
  versions?: Array<{ version: string; state?: string; newEntries?: string[]; reportKey?: string | null }>;
  repository?: string | null;
  flag?: string;
  advisoryFor?: string;
  reported?: boolean;
  contents?: Record<string, { readme: string | null; files: Array<{ path: string; text: string }> } | null>;
  skipListing?: boolean;
  skipHistory?: boolean;
  report?: unknown;
  rating?: number | null;
  oidc?: boolean;
}

async function site(seed: Seed = {}) {
  const { d1 } = migratedD1();
  const fakes = createFakePorts({ worker: "web" });
  const versions = seed.versions ?? [{ version: "1.0.0" }];
  await d1.query("INSERT INTO scopes (id, name, kind, state, verified_domain, verified_github_org, created_at) VALUES ('s1', 'acme', 'org', 'active', 'acme.com', NULL, ?)", [PUBLISHED]);
  await d1.query("INSERT INTO packs (id, scope_id, name, visibility, created_at) VALUES ('p1', 's1', 'gcp', 'public', ?)", [PUBLISHED]);
  for (const v of versions) {
    await d1.query(
      `INSERT INTO pack_versions (id, pack_id, version, state, sha256, upload_sha256, size_bytes, published_at, verified, verified_domain, source_verified, min_engine_version, requires, score, report_key) VALUES (?, 'p1', ?, ?, ?, ?, 5, ?, 1, 'acme.com', ${seed.oidc ? 1 : 0}, '1.0.0', '[]', 72, ?)`,
      [`v-${v.version}`, v.version, v.state ?? "active", SHA, UPLOAD, PUBLISHED, v.reportKey ?? null],
    );
  }
  if (!seed.skipListing) {
    const card = { inventory_counts: { skills: 2, guards: 1 }, context_cost: 1, verdict: "pass", repository: seed.repository === undefined ? "github.com/acme/gcp" : seed.repository, score_parts: [] };
    await d1.query("INSERT INTO pack_search (pack_id, name, pitch, category, tags, skills, parts, has_repository, card, updated_at) VALUES ('p1', ?, 'Deploys things to GCP', 'cloud', '', '', 'skills guards', ?, ?, ?)", [NAME, seed.repository === null ? 0 : 1, JSON.stringify(card), PUBLISHED]);
    await d1.query("INSERT INTO pack_stats (pack_id, fetches_30d, fetches_7d, fetches_prev_28d, stars, rating, computed_at) VALUES ('p1', 120, 30, 90, 3, ?, ?)", [seed.rating === undefined ? 4.2 : seed.rating, PUBLISHED]);
  }
  if (seed.flag) await d1.query("INSERT INTO feature_flags (key, value, security, updated_at) VALUES ('cn_min_adopt_version', ?, 0, ?)", [JSON.stringify(seed.flag), PUBLISHED]);
  if (seed.advisoryFor) {
    await d1.query("INSERT INTO users (id, handle, created_at) VALUES ('u1', 'rep', ?)", [PUBLISHED]).catch(() => undefined);
    await d1.query("INSERT INTO reports (id, pack_id, reporter_id, kind, version, severity, title, repro, environment, route, disclosure_deadline, created_at, updated_at) VALUES ('r1', 'p1', 'u1', 'security', ?, 'high', 't', 'r', 'e', 'registry_security', ?, ?, ?)", [seed.advisoryFor, PUBLISHED, PUBLISHED, PUBLISHED]);
    await d1.query("INSERT INTO advisories (id, pack_id, report_id, summary, severity, fixed_in, published_at) VALUES ('adv1', 'p1', 'r1', 'Leaks tokens', 'high', NULL, ?)", [PUBLISHED]);
    await d1.query("INSERT INTO advisory_versions (advisory_id, pack_id, version) VALUES ('adv1', 'p1', ?)", [seed.advisoryFor]);
  }
  if (seed.reported) {
    await d1.query("INSERT OR IGNORE INTO users (id, handle, created_at) VALUES ('u1', 'rep', ?)", [PUBLISHED]);
    await d1.query("INSERT INTO reports (id, pack_id, reporter_id, kind, version, severity, title, repro, environment, route, disclosure_deadline, created_at, updated_at) VALUES ('r2', 'p1', 'u1', 'security', '1.0.0', 'critical', 't', 'r', 'e', 'registry_security', ?, ?, ?)", [PUBLISHED, PUBLISHED, PUBLISHED]);
  }
  const put = (key: string, value: unknown) => void fakes.r2.PACKS_PUBLIC?.put(key, text(value));
  for (const v of versions) {
    put(`${NAME}/${v.version}/meta.json`, meta(v.version, { ...(v.newEntries ? { preinstall: preinstall({ guards: [{ name: "no-secrets", tool_calls: [] }], new: v.newEntries }) } : {}), ...(seed.oidc ? { provenance: OIDC } : {}) }));
    put(`${NAME}/${v.version}/.attestation.json`, attestation(v.version));
    const contents = seed.contents?.[v.version];
    if (contents !== null) {
      put(`${NAME}/${v.version}/contents.json`, contents ?? { readme: "# Deploys\n\nSee [docs](https://example.com/x).\n", files: [{ path: "README.md", text: "# Deploys\n" }, { path: "skills/deploy/SKILL.md", text: "# Deploy\nbody\n" }, { path: "guards/page.html", text: "<script>alert(1)</script>" }] });
    }
  }
  if (!seed.skipHistory) {
    put(`${NAME}/versions.json`, {
      kind: "versions", pack: NAME, serial: 1, generated_at: PUBLISHED, expires: "2026-10-29T10:00:00.000Z", kid: "k", signature: "s",
      versions: versions.map((v) => record(v.version, v.state ?? "active", v.newEntries ? { preinstall: preinstall({ new: v.newEntries }) } : {})),
    });
  }
  if (seed.report !== undefined) put("reports/v-1.0.0.json", seed.report);

  const runtime: WebRuntime = {
    worker: "web", environment: "test", version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE }, missingBindings: [], missingSecrets: [],
    ports: { ...fakes, d1, githubLogin: { authorizeUrl: async () => "", profile: async () => { throw new Error("unused"); } } }, services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { cdnOrigin: "https://packs.test.invalid", siteOrigins: ["https://registry.test.invalid"] },
  };
  const app = createApp(runtime);
  return {
    d1: d1 as D1,
    get: async (path: string) => {
      const res = await app.request(path);
      return { status: res.status, html: await res.text(), headers: res.headers };
    },
  };
}

describe("pack page overview (REQ-SEARCH-014)", () => {
  it("leads with name and pitch, the mark with its proof, the manifest line and the adopt block", async () => {
    const { html } = await (await site({ flag: "1.62000.0" })).get(`/packs/${NAME}`);
    expect(html).toContain(">@acme/gcp<");
    expect(html).toContain("Deploys things to GCP");
    expect(html).toContain(">acme.com<");
    expect(html).not.toContain("Verified Publisher");
    expect(html).toContain("Adds 1 guard");
    expect(html).toContain("cn adopt @acme/gcp");
    expect(html).toContain("packs.declared: [&quot;@acme/gcp&quot;]");
    expect(html.indexOf("Adds 1 guard")).toBeLessThan(html.indexOf('class="readme"'));
  });

  it("shows the Preview line and no packs.declared entry while the flag is unset", async () => {
    const { html } = await (await site()).get(`/packs/${NAME}`);
    expect(html).toContain("Preview: adoptable with cn ≥ 1.0.0");
    expect(html).not.toContain("packs.declared");
    expect(html).not.toContain("cn adopt");
  });

  it("keeps newest version, score, rating, fetches, contents and hashes on the page, one gesture away", async () => {
    const { html } = await (await site()).get(`/packs/${NAME}`);
    expect(html).toContain("1.0.0 · published");
    expect(html).toContain("2026-10-22");
    expect(html).toContain("Score 72 of 100");
    expect(html).toContain("<b>4.2</b>");
    expect(html).toContain("about 120 fetches in 30 days");
    expect(html).toContain("2 skills · 1 guard");
    expect(html).toContain(SHA);
    expect(html).toContain("github.com/acme/gcp");
  });

  it("names the single largest improvement beside the score", async () => {
    const { html } = await (await site()).get(`/packs/${NAME}`);
    expect(html).toMatch(/<span class="improve">\+9 Shorten RULES\.md and the skill descriptions<\/span>/);
  });

  it("says No public repo in place of the link, and never mentions visibility", async () => {
    const { html } = await (await site({ repository: null })).get(`/packs/${NAME}`);
    expect(html).toContain("No public repo");
    expect(html.replace(/<style[\s\S]*?<\/style>/g, "")).not.toMatch(/visibility/i);
  });

  it("marks entries new in the manifest line", async () => {
    const { html } = await (await site({ versions: [{ version: "1.0.0" }, { version: "1.1.0", newEntries: ["guard:no-secrets"] }] })).get(`/packs/${NAME}`);
    expect(html).toContain("new in 1.1.0");
    expect(html).toContain("New: guard:no-secrets");
  });

  it("renders a sanitised README with nofollow ugc links (REQ-DELIV-012)", async () => {
    const markdown = "<script>alert(1)</script>\n\n<img src=x onclick=\"boom()\">\n\n<iframe src=\"https://evil.example\"></iframe>\n\n[js](javascript:alert(1))\n\n[ok](https://example.com/page)\n";
    const { html } = await (await site({ contents: { "1.0.0": { readme: markdown, files: [] } } })).get(`/packs/${NAME}`);
    const readme = /<div class="readme">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(readme).not.toMatch(/<script|onclick|<iframe|javascript:/i);
    expect(readme).toContain('rel="nofollow ugc"');
  });

  it("opens with one status line carrying the reason and the advisory link when the newest version is quarantined", async () => {
    const versions = [{ version: "1.0.0" }, { version: "1.1.0", state: "quarantined" }];
    const { html } = await (await site({ versions, advisoryFor: "1.1.0" })).get(`/packs/${NAME}`);
    expect(html.match(/class="status-line/g)).toHaveLength(1);
    expect(html).toContain("1.1.0 is quarantined, under review: because");
    expect(html).toContain('href="/packs/@acme/gcp/versions#advisory-adv1"');
    expect(html.indexOf('class="status-line')).toBeLessThan(html.indexOf('class="pk-head'));
  });

  it("leads with the revoked line, and still shows the page when no version is eligible", async () => {
    const { status, html } = await (await site({ versions: [{ version: "1.0.0", state: "revoked" }] })).get(`/packs/${NAME}`);
    expect(status).toBe(200);
    expect(html).toContain("1.0.0 is revoked: because");
    expect(html).not.toContain("Adds ");
  });

  it("labels a pack with a high-severity open report", async () => {
    const { html } = await (await site({ reported: true })).get(`/packs/${NAME}`);
    expect(html).toContain("Reported, under review");
    expect(html.match(/class="status-line/g)).toHaveLength(1);
  });

  it("shows no status line for a healthy pack", async () => {
    expect((await (await site()).get(`/packs/${NAME}`)).html).not.toContain('class="status-line');
  });
});

describe("trust drawer (REQ-VAL-042, REQ-VAL-015)", () => {
  it("holds hashes, attestation, key id, proofs and the source, with warnings counted by category", async () => {
    const report = {
      run_id: "run-9", pack: NAME, version: "1.0.0", rules_version: "2026.10.1", started_at: PUBLISHED, finished_at: PUBLISHED, verdict: "warn", steps: [],
      findings: [
        { rule: "license.missing", class: "warn", file: null, line: null, quote: null, hint: "h" },
        { rule: "docs.readme-missing", class: "warn", file: null, line: null, quote: null, hint: "h" },
        { rule: "text.mixed-script", class: "warn", file: "a", line: 1, quote: null, hint: "h" },
        { rule: "text.mixed-script", class: "warn", file: "b", line: 1, quote: null, hint: "h" },
      ],
      tree_hash: null, canonical_sha256: SHA, source_verified: false, prose_screen: null, score: 72,
    };
    const { html } = await (await site({ versions: [{ version: "1.0.0", reportKey: "reports/v-1.0.0.json" }], report })).get(`/packs/${NAME}`);
    const drawer = /<aside class="drawer"[\s\S]*<\/aside>/.exec(html)?.[0] ?? "";
    expect(drawer).toContain(SHA);
    expect(drawer).toContain(UPLOAD);
    expect(drawer).toContain("Signing key 2026-10");
    expect(drawer).toContain("https://packs.test.invalid/@acme/gcp/1.0.0/.attestation.json");
    expect(drawer).toContain("Domain proven: acme.com");
    expect(drawer).toContain("Published by upload; no source was verified");
    expect(drawer).toContain("Text 2");
    expect(drawer).toContain("License 1");
    expect(drawer).toContain("Docs 1");
    expect(drawer).toContain('href="/validation/run-9"');
    expect(html.replace(drawer, "")).not.toMatch(/warning/i);
  });

  it("shows the source of a trusted-published version and that its tree was verified", async () => {
    const { html } = await (await site({ oidc: true })).get(`/packs/${NAME}`);
    const drawer = /<aside class="drawer"[\s\S]*<\/aside>/.exec(html)?.[0] ?? "";
    expect(drawer).toContain("Repository acme/packs");
    expect(drawer).toContain("c".repeat(40));
    expect(drawer).toContain("Published with trusted publishing");
    expect(drawer).toContain("The source tree was verified against the archive");
  });

  it("says warnings are unavailable instead of zero when the report cannot be read", async () => {
    const { html } = await (await site({ versions: [{ version: "1.0.0", reportKey: "reports/missing.json" }] })).get(`/packs/${NAME}`);
    expect(html).toContain("Warnings are unavailable right now");
    expect(html).not.toContain("No warnings");
  });
});

describe("contents tab (REQ-SEARCH-022)", () => {
  it("lists every file by part and shows HTML as escaped text, with section anchors", async () => {
    const { status, html } = await (await site()).get(`/packs/${NAME}/contents`);
    expect(status).toBe(200);
    expect(html).toContain("<h2>docs</h2>");
    expect(html).toContain("<h2>skills</h2>");
    expect(html).toContain("<h2>guards</h2>");
    expect(html).toContain(`id="${fileAnchor("skills/deploy/SKILL.md")}~deploy"`);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("answers an error state, not an empty tab, when the files cannot be read", async () => {
    const { status, html } = await (await site({ contents: { "1.0.0": null } })).get(`/packs/${NAME}/contents`);
    expect(status).toBe(503);
    expect(html).toContain("Contents are unavailable");
  });

  it("keeps the overview up and says the README could not load", async () => {
    const { status, html } = await (await site({ contents: { "1.0.0": null } })).get(`/packs/${NAME}`);
    expect(status).toBe(200);
    expect(html).toContain("The README could not be loaded");
  });

  it("serves the same files as JSON, by part", async () => {
    const t = await site();
    const res = await t.get(`/api/packs/${NAME}/contents`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.html) as { files: Array<{ path: string; part: string }> };
    expect(body.files.map((f) => [f.path, f.part])).toEqual([["README.md", "docs"], ["skills/deploy/SKILL.md", "skills"], ["guards/page.html", "guards"]]);
  });

  it("does not serve the files of a quarantined or unknown version", async () => {
    const t = await site({ versions: [{ version: "1.0.0" }, { version: "1.1.0", state: "quarantined" }] });
    expect((await t.get(`/api/packs/${NAME}/contents?version=1.1.0`)).status).toBe(404);
    expect((await t.get(`/api/packs/${NAME}/contents?version=9.9.9`)).status).toBe(404);
    expect((await t.get(`/api/packs/@nobody/none/contents`)).status).toBe(404);
  });
});

describe("versions tab (REQ-SEARCH-014)", () => {
  it("lists rows from the signed history with status words and the widening marker", async () => {
    const versions = [{ version: "1.0.0", state: "deprecated" }, { version: "1.1.0", newEntries: ["guard:no-secrets"] }];
    const { status, html } = await (await site({ versions })).get(`/packs/${NAME}/versions`);
    expect(status).toBe(200);
    expect(html.indexOf(">1.1.0<")).toBeLessThan(html.indexOf(">1.0.0<"));
    expect(html).toContain("Deprecated");
    expect(html).toContain("Active");
    expect(html).toContain("widens");
    expect(html.match(/widens/g)).toHaveLength(1);
  });

  it("fails the load when the signed history cannot be read", async () => {
    const { status } = await (await site({ skipHistory: true })).get(`/packs/${NAME}/versions`);
    expect(status).toBe(503);
  });
});

describe("failure states", () => {
  it("answers 404 for an unknown pack and 503 when the listing is missing", async () => {
    expect((await (await site()).get("/packs/@nobody/none")).status).toBe(404);
    const missing = await (await site({ skipListing: true })).get(`/packs/${NAME}`);
    expect(missing.status).toBe(503);
    expect(missing.html).toContain("This pack is unavailable");
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 410 for a removed pack", async () => {
    const { status } = await (await site({ versions: [{ version: "1.0.0", state: "removed" }] })).get(`/packs/${NAME}`);
    expect(status).toBe(410);
  });

  it("does not share a response that carries a session cookie", async () => {
    const t = await site();
    expect((await t.get(`/packs/${NAME}`)).headers.get("cache-control")).toContain("public");
  });
});

describe("private packs", () => {
  it("show the lock glyph", () => {
    const data = { name: NAME, visibility: "private", pitch: "p", listing: { versions: [] }, advisories: [], reported: false, profile: { verified_domain: null, verified_github_org: null, verified_publisher: false } } as unknown as PackData;
    const html = String(<Head data={data} />);
    expect(html).toContain('aria-label="Private"');
    expect(String(<Head data={{ ...data, visibility: "public" }} />)).not.toContain('aria-label="Private"');
  });
});

describe("sections", () => {
  it("splits a markdown file before each heading and joins back to the file", () => {
    const body = "intro\n# One\na\n```\n# not a heading\n```\n## Two\nb\n# One\nc\n";
    const sections = sectionsOf("RULES.md", body);
    expect(sections.map((s) => s.id.split("~")[1])).toEqual(["top", "one", "two", "one-2"]);
    expect(sections.map((s) => s.text).join("")).toBe(body);
  });

  it("starts at the first heading when a file opens with one", () => {
    const body = "# One\na\n## Two\nb\n";
    const sections = sectionsOf("RULES.md", body);
    expect(sections.map((s) => s.id.split("~")[1])).toEqual(["one", "two"]);
    expect(sections.map((s) => s.text).join("")).toBe(body);
  });

  it("keeps a non-markdown file whole and gives distinct paths distinct anchors", () => {
    expect(sectionsOf("checks/a.go", "x\n# y\n")).toHaveLength(1);
    expect(fileAnchor("a b")).not.toBe(fileAnchor("a-b"));
  });

  it("places files in the part their path names", () => {
    expect(["README.md", "pack.json", "RULES.md", "skills/a/SKILL.md", "declared-checks.json", "checks/x.go", "guards/g.json", "tasks/t.json", "extra.txt"].map(partOf)).toEqual([
      "docs", "manifest", "rules", "skills", "checks", "checks", "guards", "tasks", "other",
    ]);
  });
});

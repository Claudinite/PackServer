import { describe, expect, it } from "vitest";
import { bisect, canonicalPackId, GithubUnreachable, parseDeclared, runScan, searchQuery, type Declaration, type ScanDeps, type ScanState, type ScanStore, type SearchAnswer } from "../index.ts";

describe("parseDeclared", () => {
  it("reads bare, quoted, flow and mapping entries and nothing outside packs.declared", () => {
    const text = [
      "engine:",
      '  channel: "staging"',
      "packs:",
      '  channel: "canary"',
      "  declared:",
      '    - "basics"   # canon',
      "    - '@acme/gcp@1.0.0'",
      "    - name: \"@acme/aws\"",
      '      version: "2.1.0"',
      "    - id: @acme/azure",
      "  manager:",
      "    repo: x/y",
      "tasks:",
      "  declared:",
      "    - nope",
    ].join("\n");
    expect(parseDeclared(text)).toEqual([
      { id: "basics", version: null },
      { id: "@acme/gcp", version: "1.0.0" },
      { id: "@acme/aws", version: "2.1.0" },
      { id: "@acme/azure", version: null },
    ]);
    expect(parseDeclared("packs:\n  declared: [basics, \"@acme/gcp\"]\n")).toEqual([
      { id: "basics", version: null },
      { id: "@acme/gcp", version: null },
    ]);
    expect(parseDeclared("engine: {}\n")).toEqual([]);
    expect(parseDeclared("packs:\n  channel: canary\n")).toEqual([]);
  });
});

describe("pack ids", () => {
  it("maps an unscoped id to the canon scope and leaves a scoped one", () => {
    expect(canonicalPackId("basics")).toBe("@claudinite/basics");
    expect(canonicalPackId("@Acme/GCP")).toBe("@acme/gcp");
    expect(canonicalPackId("not a pack")).toBeNull();
  });

  it("searches canon packs by the unscoped text and others by the scoped id", () => {
    const window = { from: "2008-01-01", to: "2026-01-15" };
    expect(searchQuery("@claudinite/basics", window)).toContain('"basics"');
    expect(searchQuery("@acme/gcp", window)).toContain('"@acme/gcp"');
    expect(searchQuery("@acme/gcp", window)).toContain("created:2008-01-01..2026-01-15");
  });
});

describe("bisect", () => {
  it("covers a window exactly once and stops at a single day", () => {
    const [a, b] = bisect({ from: "2026-01-01", to: "2026-01-04" })!;
    expect([a, b]).toEqual([
      { from: "2026-01-01", to: "2026-01-02" },
      { from: "2026-01-03", to: "2026-01-04" },
    ]);
    expect(bisect({ from: "2026-01-01", to: "2026-01-01" })).toBeNull();
  });
});

interface Repo {
  private?: boolean;
  file: string;
  createdAt?: string;
}

function memoryStore(packs: string[]) {
  const scans = new Map<string, ScanState & { rate: number | null }>();
  const rows: Array<Declaration & { scanId: string }> = [];
  const completedAt = new Map<string, string>();
  const store: ScanStore = {
    async open() {
      return [...scans.values()].find((s) => s.completedAt === null) ?? null;
    },
    async lastCompletedAt() {
      return [...completedAt.values()].sort().at(-1) ?? null;
    },
    async begin(id, now) {
      const s = { id, startedAt: now, completedAt: null, cursor: null, truncated: false, rate: null };
      scans.set(id, s);
      return s;
    },
    async packsAfter(after) {
      return packs.filter((p) => after === null || p > after).sort().slice(0, 1);
    },
    async declare(scanId, more) {
      for (const r of more) if (!rows.some((x) => x.scanId === scanId && x.pack === r.pack && x.repository === r.repository)) rows.push({ ...r, scanId });
    },
    async save(id, p) {
      Object.assign(scans.get(id)!, { cursor: p.cursor, truncated: p.truncated, rate: p.rateRemaining });
    },
    async complete(id, now) {
      scans.get(id)!.completedAt = now;
      completedAt.set(id, now);
      const mine = rows.filter((r) => r.scanId === id);
      return { repositories: new Set(mine.map((r) => r.repository)).size, packs: new Set(mine.map((r) => r.pack)).size };
    },
  };
  return { store, rows, scans };
}

function harness(repos: Record<string, Repo>, packs: string[], over: Partial<ScanDeps> & { totalFor?: (q: string) => number | undefined; perCall?: () => void } = {}) {
  let now = Date.parse("2026-01-15T10:00:00Z");
  const queries: string[] = [];
  const reads: string[] = [];
  const { store, rows, scans } = memoryStore(packs);
  const deps: ScanDeps = {
    source: {
      async search(query, page): Promise<SearchAnswer> {
        over.perCall?.();
        queries.push(`${page}:${query}`);
        const term = /^"([^"]+)"/.exec(query)![1]!;
        const found = Object.entries(repos).filter(([, r]) => r.file.includes(term));
        const total = over.totalFor?.(query) ?? found.length;
        const slice = found.slice((page - 1) * 100, page * 100);
        return { totalCount: total, hits: slice.map(([name, r]) => ({ repository: name, private: r.private === true, path: "conf/settings.yaml" })), rateRemaining: 9, rateResetInS: 60 };
      },
      async readFile(repository) {
        reads.push(repository);
        return repos[repository]?.file ?? null;
      },
    },
    store,
    now: () => now,
    sync: async () => {},
    sleep: async (ms) => void (now += ms),
    newId: (() => {
      let n = 0;
      return () => `scan-${++n}`;
    })(),
    ...over,
  };
  return { deps, rows, scans, queries, reads, advance: (ms: number) => void (now += ms) };
}

const settings = (...declared: string[]) => `packs:\n  declared:\n${declared.map((d) => `    - ${d}`).join("\n")}\n`;

describe("runScan", () => {
  it("records declaring repositories with their pins, maps unscoped canon ids, and never reads a private repository", async () => {
    const h = harness(
      {
        "a/one": { file: settings('"@acme/gcp@1.0.0"', "basics") },
        "b/two": { file: settings('"@acme/gcp"') },
        "c/secret": { file: settings('"@acme/gcp"'), private: true },
        "d/near": { file: settings('"@acme/gcp-extra"') },
      },
      ["@acme/gcp", "@claudinite/basics"],
    );
    const result = await runScan(h.deps);
    expect(result.outcome).toBe("completed");
    expect(h.rows.map((r) => [r.pack, r.repository, r.pinnedVersion])).toEqual([
      ["@acme/gcp", "a/one", "1.0.0"],
      ["@acme/gcp", "b/two", null],
      ["@claudinite/basics", "a/one", null],
    ]);
    expect(h.reads).not.toContain("c/secret");
    expect(h.rows.every((r) => r.owner === r.repository.split("/")[0])).toBe(true);
  });

  it("stops at its time limit, saves where it was, and the next run resumes there without repeating work", async () => {
    const repos = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`o/r${i}`, { file: settings("'@acme/a'", "'@acme/b'", "'@acme/c'") }]));
    const h = harness(repos, ["@acme/a", "@acme/b", "@acme/c"], { perCall: () => h.advance(6 * 60_000) });
    const first = await runScan(h.deps);
    expect(first.outcome).toBe("deadline");
    expect(h.scans.get("scan-1")!.cursor).not.toBeNull();
    const seen = h.queries.length;
    const second = await runScan(h.deps);
    expect(["deadline", "completed"]).toContain(second.outcome);
    let last = second;
    while (last.outcome !== "completed") last = await runScan(h.deps);
    expect(new Set(h.queries).size).toBe(h.queries.length);
    expect(h.queries.length).toBeGreaterThan(seen);
    expect(h.rows).toHaveLength(9);
    expect(h.scans.size).toBe(1);
  });

  it("splits a query that matches more than the search can return by creation date", async () => {
    const h = harness({ "a/one": { file: settings("'@acme/gcp'") } }, ["@acme/gcp"], {
      totalFor: (q) => (q.includes("created:2008-01-01..2026-01-15") ? 1500 : undefined),
    });
    const result = await runScan(h.deps);
    expect(result.outcome).toBe("completed");
    const windows = h.queries.map((q) => /created:(\S+)/.exec(q)![1]);
    expect(windows[0]).toBe("2008-01-01..2026-01-15");
    expect(windows.length).toBeGreaterThan(2);
    expect(h.scans.get("scan-1")!.truncated).toBe(false);
  });

  it("marks a scan truncated when one day alone still overflows", async () => {
    const h = harness({ "a/one": { file: settings("'@acme/gcp'") } }, ["@acme/gcp"], { totalFor: () => 5000 });
    await runScan(h.deps);
    expect(h.scans.get("scan-1")!.truncated).toBe(true);
  });

  it("stops at its request allowance mid-page and redoes the unfinished page next run without duplicating", async () => {
    const repos = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`o/r${i}`, { file: settings("'@acme/a'") }]));
    const h = harness(repos, ["@acme/a"], { limits: { requestsPerRun: 3 } });
    expect((await runScan(h.deps)).outcome).toBe("request_budget");
    expect(h.rows).toHaveLength(2);
    h.deps.limits = { requestsPerRun: 50 };
    expect((await runScan(h.deps)).outcome).toBe("completed");
    expect(h.rows).toHaveLength(5);
  });

  it("waits out a spent rate limit when the run has time, and stops when it has not", async () => {
    let calls = 0;
    const h = harness({ "a/one": { file: settings("'@acme/a'") } }, ["@acme/a"]);
    const inner = h.deps.source.search;
    h.deps.source.search = async (q, p) => (++calls === 1 ? { limited: { retryAfterS: 30 } } : inner(q, p));
    expect((await runScan(h.deps)).outcome).toBe("completed");

    const slow = harness({}, ["@acme/a"]);
    slow.deps.source.search = async () => ({ limited: { retryAfterS: 900 } });
    expect((await runScan(slow.deps)).outcome).toBe("rate_limited");
    expect(slow.scans.get("scan-1")!.completedAt).toBeNull();
  });

  it("keeps its place when GitHub is unreachable", async () => {
    const h = harness({ "a/one": { file: settings("'@acme/a'") } }, ["@acme/a", "@acme/b"]);
    const inner = h.deps.source.search;
    h.deps.source.search = async (q, p) => {
      if (q.startsWith('"@acme/b"')) throw new GithubUnreachable("down");
      return inner(q, p);
    };
    expect((await runScan(h.deps)).outcome).toBe("unreachable");
    expect(h.scans.get("scan-1")!.cursor).toMatchObject({ after: "@acme/a" });
  });

  it("does not start a second scan right after one completed, unless forced", async () => {
    const h = harness({}, ["@acme/a"]);
    expect((await runScan(h.deps)).outcome).toBe("completed");
    expect((await runScan(h.deps)).outcome).toBe("idle");
    h.deps.force = true;
    expect((await runScan(h.deps)).outcome).toBe("completed");
    expect(h.scans.size).toBe(2);
  });
});

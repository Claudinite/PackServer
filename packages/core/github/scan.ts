import type { D1 } from "@packserver/ports";
import { GithubUnreachable } from "./reader.ts";

/** What the public label says wherever a declaring count is shown (REQ-TELEM-007). */
export const ADOPTION_LABEL = "approximate, weekly";

export const SCAN_LIMITS = {
  runMs: 10 * 60_000,
  /** GitHub answers at most 1,000 results per query, in pages of 100. */
  resultsPerQuery: 1000,
  perPage: 100,
  /** Stays under the subrequests one invocation may make. */
  requestsPerRun: 900,
  /** A scan finished more recently than this is not started again by the cron. */
  freshMs: 6 * 86_400_000,
} as const;

export const SETTINGS_FILENAME = "settings.yaml";
export const SETTINGS_DIRECTORY = ".claudinite";
const CANON_SCOPE = "@claudinite";
const EARLIEST_REPOSITORY = "2008-01-01";

export interface Declared {
  id: string;
  version: string | null;
}

const unquote = (value: string): string => {
  const text = value.replace(/\s+#.*$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted ? quoted[2]! : text;
};
const indentOf = (line: string): number => line.length - line.trimStart().length;
const KEY = /^(["']?)([\w.-]+)\1\s*:\s*(.*)$/;

/**
 * The `packs.declared` entries of a Claudinite settings file. An entry is a bare id, an
 * `id@version` string, or a mapping with `id`, `name` or `pack` and an optional `version`.
 * Only the `packs:` block is read, so no YAML parser is needed for the rest of the file.
 */
export function parseDeclared(text: string): Declared[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  const packsAt = lines.findIndex((l) => indentOf(l) === 0 && /^packs\s*:\s*$/.test(l.trimEnd()));
  if (packsAt < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(packsAt + 1)) {
    if (indentOf(line) === 0) break;
    block.push(line);
  }
  const declaredAt = block.findIndex((l) => /^\s*declared\s*:/.test(l));
  if (declaredAt < 0) return [];
  const header = block[declaredAt]!;
  const declaredIndent = indentOf(header);
  const inline = header.slice(header.indexOf(":") + 1).trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]\s*(#.*)?$/g, "")
      .split(",")
      .map((s) => entry(unquote(s)))
      .filter((d): d is Declared => d !== null);
  }
  const items: string[][] = [];
  for (const line of block.slice(declaredAt + 1)) {
    if (indentOf(line) <= declaredIndent && !line.trimStart().startsWith("- ")) break;
    if (indentOf(line) < declaredIndent) break;
    if (line.trimStart().startsWith("- ")) items.push([line.trimStart().slice(2)]);
    else items.at(-1)?.push(line.trim());
  }
  return items.map(fromItem).filter((d): d is Declared => d !== null);
}

function fromItem(parts: string[]): Declared | null {
  const first = parts[0]!;
  if (!KEY.test(first) || /^["']/.test(first)) return entry(unquote(first));
  const fields = new Map<string, string>();
  for (const part of parts) {
    const m = KEY.exec(part);
    if (m) fields.set(m[2]!, unquote(m[3]!));
  }
  const id = fields.get("id") ?? fields.get("name") ?? fields.get("pack");
  const version = fields.get("version");
  return id ? entry(id, version) : null;
}

function entry(text: string, version?: string): Declared | null {
  if (text === "") return null;
  const at = text.lastIndexOf("@");
  const pinned = at > 0 ? text.slice(at + 1) : "";
  const id = at > 0 ? text.slice(0, at) : text;
  const frozen = version ?? (pinned !== "" ? pinned : null);
  return { id, version: frozen === "" ? null : frozen };
}

/** A scoped id as written; an unscoped one predates the cutover and means the canon pack of that name. */
export function canonicalPackId(id: string): string | null {
  if (/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(id)) return id.toLowerCase();
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return `${CANON_SCOPE}/${id.toLowerCase()}`;
  return null;
}

/** The text a settings file would hold for this pack: canon packs may still be written unscoped. */
const searchTerm = (pack: string): string => (pack.startsWith(`${CANON_SCOPE}/`) ? pack.slice(CANON_SCOPE.length + 1) : pack);

export interface DateWindow {
  from: string;
  to: string;
}

export function searchQuery(pack: string, window: DateWindow): string {
  return `"${searchTerm(pack)}" path:${SETTINGS_DIRECTORY} filename:${SETTINGS_FILENAME} created:${window.from}..${window.to}`;
}

const DAY_MS = 86_400_000;
const dayOf = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const isoOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Two windows that together cover this one, or null when it is a single day. */
export function bisect(window: DateWindow): [DateWindow, DateWindow] | null {
  const from = dayOf(window.from);
  const to = dayOf(window.to);
  if (to <= from) return null;
  const mid = Math.floor((from + to) / 2);
  return [
    { from: window.from, to: isoOf(mid) },
    { from: isoOf(mid + 1), to: window.to },
  ];
}

export interface Cursor {
  /** The last pack whose queries finished. */
  after: string | null;
  /** The pack being searched; absent between packs. */
  pack?: string;
  /** Creation-date windows still to search for `pack`, the one being read first. */
  windows: DateWindow[];
  page: number;
}

export interface SearchHit {
  repository: string;
  private: boolean;
  path: string;
}
export interface SearchPage {
  totalCount: number;
  hits: SearchHit[];
  rateRemaining: number | null;
  /** When the allowance is spent, how long until it is back. */
  rateResetInS: number | null;
}
export type SearchAnswer = SearchPage | { limited: { retryAfterS: number } };

/** Read-only by construction: nothing here can change anything on GitHub. */
export interface ScanSource {
  search(query: string, page: number): Promise<SearchAnswer>;
  /** A file of a public repository, from its default branch; null when it is not there or the repository is not public. */
  readFile(repository: string, path: string): Promise<string | null>;
}

export interface Declaration {
  pack: string;
  repository: string;
  owner: string;
  pinnedVersion: string | null;
  settingsPath: string;
}

export interface ScanState {
  id: string;
  startedAt: string;
  completedAt: string | null;
  cursor: Cursor | null;
  truncated: boolean;
}

export interface ScanStore {
  /** The newest scan that has not completed. */
  open(): Promise<ScanState | null>;
  lastCompletedAt(): Promise<string | null>;
  begin(id: string, now: string): Promise<ScanState>;
  /** Public packs by name, after `after`. */
  packsAfter(after: string | null, limit: number): Promise<string[]>;
  declare(scanId: string, rows: Declaration[]): Promise<void>;
  save(scanId: string, progress: { cursor: Cursor; rateRemaining: number | null; truncated: boolean; now: string }): Promise<void>;
  /** Marks it complete and drops every scan older than the one before it. */
  complete(scanId: string, now: string, rateRemaining: number | null): Promise<{ repositories: number; packs: number }>;
}

export type ScanOutcome = "completed" | "deadline" | "request_budget" | "rate_limited" | "unreachable" | "idle";

export interface ScanResult {
  outcome: ScanOutcome;
  scanId: string | null;
  pages: number;
  declarations: number;
  rateRemaining: number | null;
  summary?: { repositories: number; packs: number };
}

export interface ScanDeps {
  source: ScanSource;
  store: ScanStore;
  now(): number;
  /** Brings `now()` up to date where the clock is read remotely. */
  sync(): Promise<void>;
  sleep(ms: number): Promise<void>;
  newId(): string;
  /** Starts a scan even though one completed recently. */
  force?: boolean;
  limits?: Partial<{ runMs: number; requestsPerRun: number; freshMs: number }>;
}

const MAX_CACHED_FILES = 500;

/**
 * One run of the weekly scan: begins a scan or resumes the open one from its saved cursor, and
 * works until the scan completes or the run's time or request allowance is spent. The cursor is
 * saved after every page, so stopping anywhere loses at most the page in hand, and writing a
 * declaration twice changes nothing.
 */
export async function runScan(deps: ScanDeps): Promise<ScanResult> {
  const { source, store } = deps;
  const runMs = deps.limits?.runMs ?? SCAN_LIMITS.runMs;
  const requestBudget = deps.limits?.requestsPerRun ?? SCAN_LIMITS.requestsPerRun;
  const freshMs = deps.limits?.freshMs ?? SCAN_LIMITS.freshMs;
  await deps.sync();
  const started = deps.now();
  const iso = (ms = deps.now()) => new Date(ms).toISOString();

  let state = await store.open();
  if (!state) {
    const last = await store.lastCompletedAt();
    if (!deps.force && last !== null && started - Date.parse(last) < freshMs) {
      return { outcome: "idle", scanId: null, pages: 0, declarations: 0, rateRemaining: null };
    }
    state = await store.begin(deps.newId(), iso(started));
  }

  const result: ScanResult = { outcome: "deadline", scanId: state.id, pages: 0, declarations: 0, rateRemaining: null };
  let cursor: Cursor = state.cursor ?? { after: null, windows: [], page: 1 };
  let truncated = state.truncated;
  let requests = 0;
  const files = new Map<string, Declared[] | null>();
  const today = iso(started).slice(0, 10);

  const save = (): Promise<void> => store.save(state.id, { cursor, rateRemaining: result.rateRemaining, truncated, now: iso() });

  for (;;) {
    await deps.sync();
    if (deps.now() - started >= runMs) break;
    if (requests >= requestBudget) {
      result.outcome = "request_budget";
      break;
    }
    if (cursor.windows.length === 0) {
      const [next] = await store.packsAfter(cursor.after, 1);
      if (next === undefined) {
        result.summary = await store.complete(state.id, iso(), result.rateRemaining);
        result.outcome = "completed";
        return result;
      }
      cursor = { after: cursor.after, pack: next, windows: [{ from: EARLIEST_REPOSITORY, to: today }], page: 1 };
    }
    const pack = cursor.pack!;
    const window = cursor.windows[0]!;

    let answer: SearchAnswer;
    try {
      requests++;
      answer = await source.search(searchQuery(pack, window), cursor.page);
    } catch (error) {
      if (!(error instanceof GithubUnreachable)) throw error;
      result.outcome = "unreachable";
      break;
    }
    if ("limited" in answer) {
      const waitMs = answer.limited.retryAfterS * 1000;
      if (deps.now() - started + waitMs >= runMs) {
        result.outcome = "rate_limited";
        break;
      }
      await deps.sleep(waitMs);
      continue;
    }
    result.pages++;
    if (answer.rateRemaining !== null) result.rateRemaining = answer.rateRemaining;

    const halves = answer.totalCount > SCAN_LIMITS.resultsPerQuery ? bisect(window) : null;
    if (halves) {
      cursor = { ...cursor, windows: [...halves, ...cursor.windows.slice(1)], page: 1 };
      await save();
      continue;
    }
    if (answer.totalCount > SCAN_LIMITS.resultsPerQuery) truncated = true;

    const rows: Declaration[] = [];
    let pageDone = true;
    for (const hit of answer.hits) {
      if (hit.private) continue;
      const cacheKey = `${hit.repository}:${hit.path}`;
      let declared = files.get(cacheKey);
      if (declared === undefined) {
        if (requests >= requestBudget) {
          pageDone = false;
          break;
        }
        requests++;
        let text: string | null;
        try {
          text = await source.readFile(hit.repository, hit.path);
        } catch (error) {
          if (!(error instanceof GithubUnreachable)) throw error;
          result.outcome = "unreachable";
          return await stop(result, save);
        }
        declared = text === null ? null : parseDeclared(text);
        if (files.size >= MAX_CACHED_FILES) files.clear();
        files.set(cacheKey, declared);
      }
      const found = declared?.find((d) => canonicalPackId(d.id) === pack);
      if (found) {
        rows.push({ pack, repository: hit.repository, owner: hit.repository.split("/")[0]!.toLowerCase(), pinnedVersion: found.version, settingsPath: hit.path });
      }
    }
    if (rows.length > 0) await store.declare(state.id, rows);
    result.declarations += rows.length;
    if (!pageDone) {
      result.outcome = "request_budget";
      break;
    }

    const reachable = Math.min(answer.totalCount, SCAN_LIMITS.resultsPerQuery);
    const finished = answer.hits.length === 0 || cursor.page * SCAN_LIMITS.perPage >= reachable;
    if (!finished) {
      cursor = { ...cursor, page: cursor.page + 1 };
    } else if (cursor.windows.length > 1) {
      cursor = { ...cursor, windows: cursor.windows.slice(1), page: 1 };
    } else {
      cursor = { after: pack, windows: [], page: 1 };
    }
    await save();

    const spent = answer.rateRemaining === 0 ? (answer.rateResetInS ?? 60) * 1000 : 0;
    if (spent > 0) {
      if (deps.now() - started + spent >= runMs) {
        result.outcome = "rate_limited";
        break;
      }
      await deps.sleep(spent);
    }
  }
  return await stop(result, save);
}

async function stop(result: ScanResult, save: () => Promise<void>): Promise<ScanResult> {
  await save();
  return result;
}

export interface PackAdoption {
  /** Null until a scan has completed: unknown is not zero. */
  declaringRepositories: number | null;
  pinnedVersions: Record<string, number>;
  unpinned: number;
  /** Repositories that declared the pack in the scan before and do not in the latest. */
  dropped: number;
  scannedAt: string | null;
  label: typeof ADOPTION_LABEL;
}

/** What the latest completed scan found for one pack, against the one before it. */
export async function adoptionOf(d1: D1, pack: string): Promise<PackAdoption> {
  const { rows: scans } = await d1.query("select id, completed_at from adoption_scans where completed_at is not null order by completed_at desc, id desc limit 2");
  const latest = scans[0] as { id: string; completed_at: string } | undefined;
  if (!latest) return { declaringRepositories: null, pinnedVersions: {}, unpinned: 0, dropped: 0, scannedAt: null, label: ADOPTION_LABEL };
  const { rows } = await d1.query("select pinned_version from pack_declarations where scan_id = ? and pack = ?", [latest.id, pack]);
  const pinnedVersions: Record<string, number> = {};
  let unpinned = 0;
  for (const row of rows as Array<{ pinned_version: string | null }>) {
    if (row.pinned_version === null) unpinned++;
    else pinnedVersions[row.pinned_version] = (pinnedVersions[row.pinned_version] ?? 0) + 1;
  }
  const previous = scans[1] as { id: string } | undefined;
  let dropped = 0;
  if (previous) {
    const { rows: gone } = await d1.query(
      `select count(*) as n from pack_declarations p where p.scan_id = ? and p.pack = ?
         and not exists (select 1 from pack_declarations l where l.scan_id = ? and l.pack = p.pack and l.repository = p.repository)`,
      [previous.id, pack, latest.id],
    );
    dropped = Number((gone[0] as { n: number }).n);
  }
  return { declaringRepositories: rows.length, pinnedVersions, unpinned, dropped, scannedAt: latest.completed_at, label: ADOPTION_LABEL };
}

/** Whether this GitHub login owns a public repository the latest completed scan found declaring the pack (REQ-COMM-006). */
export async function ownsDeclaringRepository(d1: D1, owner: string, pack: string): Promise<boolean> {
  const { rows } = await d1.query(
    `select 1 from pack_declarations d where d.pack = ? and d.owner = ? and d.scan_id =
       (select id from adoption_scans where completed_at is not null order by completed_at desc, id desc limit 1) limit 1`,
    [pack, owner.toLowerCase()],
  );
  return rows.length > 0;
}

import type { D1 } from "@packserver/ports";
import { RESERVED_WORDS } from "../validation/identity/reserved.ts";
import { isNearMiss, skeleton } from "../validation/identity/similarity.ts";

export const HANDLE_MIN = 2;
export const HANDLE_MAX = 39;
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type HandleRefusal = "format" | "taken" | "reserved" | "confusable";

export type HandleVerdict = { ok: true; handle: string } | { ok: false; reason: HandleRefusal; message: string };

/** What the database says about the names a handle could collide with. */
export interface HandleFacts {
  /** A person's handle, a scope or a retired scope name already is this. */
  taken: boolean;
  /** Names of verified scopes, proven domain labels and verified GitHub organisations. */
  verifiedNames: readonly string[];
}

const RESERVED_SKELETONS = RESERVED_WORDS.map((word) => skeleton(word));

const refuse = (reason: HandleRefusal, message: string): HandleVerdict => ({ ok: false, reason, message });

export const normalizeHandle = (raw: string): string => raw.trim().toLowerCase();

/** The pure judgement; `loadHandleFacts` supplies what the database knows. */
export function judgeHandle(raw: string, facts: HandleFacts): HandleVerdict {
  const handle = normalizeHandle(raw);
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX || !HANDLE_PATTERN.test(handle)) {
    return refuse("format", `A handle is ${HANDLE_MIN} to ${HANDLE_MAX} lowercase letters, digits and single hyphens, and starts and ends with a letter or digit.`);
  }
  if (RESERVED_WORDS.includes(handle) || RESERVED_SKELETONS.includes(skeleton(handle))) {
    return refuse("reserved", `"${handle}" is a reserved name.`);
  }
  if (facts.verifiedNames.includes(handle)) {
    return refuse("reserved", `"${handle}" is the name of a verified organisation.`);
  }
  if (facts.taken) return refuse("taken", `"${handle}" is already taken.`);
  const near = facts.verifiedNames.find((name) => isNearMiss(handle, name));
  if (near) return refuse("confusable", `"${handle}" is too close to the verified name "${near}".`);
  return { ok: true, handle };
}

/** The first label of a domain, which is what a name can be confused with. */
const domainLabel = (domain: string): string => domain.split(".")[0]!.toLowerCase();

export async function loadHandleFacts(d1: D1, handle: string): Promise<HandleFacts> {
  const [taken, verified] = await d1.batch([
    {
      sql: `select 1 as hit from users where handle = ?1
            union all select 1 from scopes where name = ?1
            union all select 1 from retired_names where kind = 'scope' and name = ?1`,
      params: [handle],
    },
    { sql: "select name, verified_domain, verified_github_org from scopes where verified_domain is not null or verified_github_org is not null" },
  ]);
  const verifiedNames = new Set<string>();
  for (const row of verified!.rows) {
    verifiedNames.add(String(row.name).toLowerCase());
    if (typeof row.verified_domain === "string") verifiedNames.add(domainLabel(row.verified_domain));
    if (typeof row.verified_github_org === "string") verifiedNames.add(row.verified_github_org.toLowerCase());
  }
  return { taken: taken!.rows.length > 0, verifiedNames: [...verifiedNames] };
}

/** Sets the handle of an account that has none; the name is checked, then claimed by the unique index. */
export async function chooseHandle(d1: D1, userId: string, raw: string): Promise<HandleVerdict> {
  const handle = normalizeHandle(raw);
  const verdict = judgeHandle(handle, await loadHandleFacts(d1, handle));
  if (!verdict.ok) return verdict;
  try {
    const { meta } = await d1.query("update users set handle = ? where id = ? and handle is null", [verdict.handle, userId]);
    if (meta.changes === 0) return refuse("taken", "This account already has a handle.");
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) return refuse("taken", `"${verdict.handle}" is already taken.`);
    throw error;
  }
  return verdict;
}

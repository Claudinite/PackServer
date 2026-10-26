import { z } from "zod";
import type { ClaimCategory, RefusalReason } from "@packserver/schema";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
export const OIDC_AUDIENCE = "registry.claudinite.com";

/** Events that never publish, whatever a registration lists: they run code from outside the repository's trusted history. */
export const FORBIDDEN_EVENTS = ["pull_request", "pull_request_target", "workflow_run"] as const;
export const DEFAULT_EVENTS = ["push", "release", "workflow_dispatch"] as const;

/** The job name cn's workflow template gives the job that runs pack code; it never holds `id-token: write`. */
export const PACK_CODE_JOB = "task";

/** The claims of a GitHub Actions token the exchange reads; GitHub sends every one of these as a string. */
export const ActionsClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string(),
  repository: z.string().min(1),
  repository_id: z.string().min(1),
  repository_owner_id: z.string().min(1),
  ref: z.string().min(1),
  ref_protected: z.string(),
  job_workflow_ref: z.string().min(1),
  event_name: z.string().min(1),
  sha: z.string().min(1),
  run_id: z.string().min(1),
  environment: z.string().min(1).optional(),
  jti: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
  nbf: z.number().optional(),
});
export type ActionsClaims = z.infer<typeof ActionsClaims>;

/** What a trusted publisher row says, with the JSON columns already parsed. */
export interface Registration {
  id: string;
  repository_id: string;
  repository_owner_id: string;
  workflow: string;
  environment: string | null;
  refs: readonly string[];
  events: readonly string[];
}

/** `claims` names what mismatched for tests and logs; only `categories` may be sent to a caller. */
export type ClaimVerdict = { ok: true } | { ok: false; reason: RefusalReason; categories: ClaimCategory[]; claims: string[] };

/** The tag and branch patterns a registration gets when its owner names none. */
export function defaultRefs(packName: string, defaultBranch: string): string[] {
  return [`refs/tags/${packName}/*`, `refs/heads/${defaultBranch}`];
}

/** `*` stands for any run of characters but `/`; everything else is literal. */
export function refMatches(pattern: string, ref: string): boolean {
  const parts = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^/]*")}$`).test(ref);
}

/** `owner/repo/path/to/workflow.yml@ref` into its repository and path. */
export function parseWorkflowRef(value: string): { repository: string; path: string } | null {
  const at = value.indexOf("@");
  const head = at < 0 ? value : value.slice(0, at);
  const segments = head.split("/");
  if (segments.length < 3) return null;
  return { repository: segments.slice(0, 2).join("/"), path: segments.slice(2).join("/") };
}

const CATEGORY_OF: Record<string, ClaimCategory> = { "oidc.fork": "fork", "oidc.workflow": "workflow", "oidc.environment": "environment" };
const REASON_ORDER: RefusalReason[] = ["oidc.fork", "oidc.workflow", "oidc.environment"];

/**
 * Whether a verified token and the job it names fit one registration. Every mismatched claim is
 * counted, not the first, so the nearest registration can be chosen.
 */
export function matchRegistration(claims: ActionsClaims, job: string | null, reg: Registration): ClaimVerdict {
  const missed: string[] = [];
  const reasons = new Set<RefusalReason>();
  const miss = (claim: string, reason: RefusalReason) => {
    missed.push(claim);
    reasons.add(reason);
  };

  if (claims.repository_id !== reg.repository_id) miss("repository_id", "oidc.fork");
  if (claims.repository_owner_id !== reg.repository_owner_id) miss("repository_owner_id", "oidc.fork");

  const allowedEvents = reg.events.filter((e) => !(FORBIDDEN_EVENTS as readonly string[]).includes(e));
  if ((FORBIDDEN_EVENTS as readonly string[]).includes(claims.event_name)) miss("event_name", "oidc.fork");
  else if (!allowedEvents.includes(claims.event_name)) miss("event_name", "oidc.workflow");

  const workflow = parseWorkflowRef(claims.job_workflow_ref);
  if (workflow?.repository !== claims.repository || workflow.path !== reg.workflow) miss("job_workflow_ref", "oidc.workflow");

  if (reg.environment !== null) {
    if (claims.environment !== reg.environment) miss("environment", "oidc.environment");
  } else if (claims.ref_protected !== "true") {
    miss("ref_protected", "oidc.workflow");
  }

  if (!reg.refs.some((pattern) => refMatches(pattern, claims.ref))) miss("ref", "oidc.workflow");

  if (job === null || job === "" || job === PACK_CODE_JOB) miss("job", "oidc.workflow");

  const ordered = REASON_ORDER.filter((r) => reasons.has(r));
  const reason = ordered[0];
  return reason === undefined ? { ok: true } : { ok: false, reason, categories: ordered.map((r) => CATEGORY_OF[r]!), claims: missed };
}

/** The first registration the token fits, else the nearest miss: fewest mismatched claims, then the lowest id. */
export function chooseRegistration(
  claims: ActionsClaims,
  job: string | null,
  regs: readonly Registration[],
): { ok: true; registration: Registration } | { ok: false; reason: RefusalReason; categories: ClaimCategory[] } | null {
  let nearest: { reason: RefusalReason; categories: ClaimCategory[]; claims: string[] } | undefined;
  for (const reg of [...regs].sort((a, b) => a.id.localeCompare(b.id))) {
    const verdict = matchRegistration(claims, job, reg);
    if (verdict.ok) return { ok: true, registration: reg };
    if (!nearest || verdict.claims.length < nearest.claims.length) nearest = verdict;
  }
  return nearest ? { ok: false, reason: nearest.reason, categories: nearest.categories } : null;
}

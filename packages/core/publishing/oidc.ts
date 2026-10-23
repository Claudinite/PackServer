import { z } from "zod";
import type { ClaimDiff, RefusalReason } from "@packserver/schema";

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

export type ClaimVerdict = { ok: true } | { ok: false; reason: RefusalReason; diff: ClaimDiff };

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

const REASON_ORDER: RefusalReason[] = ["oidc.fork", "oidc.workflow", "oidc.environment"];

/**
 * Whether a verified token and the job it names fit one registration. Every mismatched claim is
 * reported, not the first, so a publisher fixes a workflow in one pass.
 */
export function matchRegistration(claims: ActionsClaims, job: string | null, reg: Registration): ClaimVerdict {
  const diff: ClaimDiff = {};
  const reasons = new Set<RefusalReason>();
  const miss = (claim: string, reason: RefusalReason, expected: unknown, actual: unknown) => {
    diff[claim] = { expected, actual };
    reasons.add(reason);
  };

  if (claims.repository_id !== reg.repository_id) miss("repository_id", "oidc.fork", reg.repository_id, claims.repository_id);
  if (claims.repository_owner_id !== reg.repository_owner_id) miss("repository_owner_id", "oidc.fork", reg.repository_owner_id, claims.repository_owner_id);

  const allowedEvents = reg.events.filter((e) => !(FORBIDDEN_EVENTS as readonly string[]).includes(e));
  if ((FORBIDDEN_EVENTS as readonly string[]).includes(claims.event_name)) miss("event_name", "oidc.fork", allowedEvents, claims.event_name);
  else if (!allowedEvents.includes(claims.event_name)) miss("event_name", "oidc.workflow", allowedEvents, claims.event_name);

  const workflow = parseWorkflowRef(claims.job_workflow_ref);
  if (workflow?.repository !== claims.repository || workflow.path !== reg.workflow) {
    miss("job_workflow_ref", "oidc.workflow", `${claims.repository}/${reg.workflow}`, workflow ? `${workflow.repository}/${workflow.path}` : claims.job_workflow_ref);
  }

  if (reg.environment !== null) {
    if (claims.environment !== reg.environment) miss("environment", "oidc.environment", reg.environment, claims.environment ?? null);
  } else if (claims.ref_protected !== "true") {
    miss("ref_protected", "oidc.workflow", "true", claims.ref_protected);
  }

  if (!reg.refs.some((pattern) => refMatches(pattern, claims.ref))) miss("ref", "oidc.workflow", reg.refs, claims.ref);

  if (job === null || job === "") miss("job", "oidc.workflow", `any job but ${PACK_CODE_JOB}`, null);
  else if (job === PACK_CODE_JOB) miss("job", "oidc.workflow", `any job but ${PACK_CODE_JOB}`, job);

  const reason = REASON_ORDER.find((r) => reasons.has(r));
  return reason === undefined ? { ok: true } : { ok: false, reason, diff };
}

/** The first registration the token fits, else the nearest miss: fewest mismatched claims, then the lowest id. */
export function chooseRegistration(
  claims: ActionsClaims,
  job: string | null,
  regs: readonly Registration[],
): { ok: true; registration: Registration } | { ok: false; reason: RefusalReason; diff: ClaimDiff } | null {
  let nearest: { reason: RefusalReason; diff: ClaimDiff; reg: Registration } | undefined;
  for (const reg of [...regs].sort((a, b) => a.id.localeCompare(b.id))) {
    const verdict = matchRegistration(claims, job, reg);
    if (verdict.ok) return { ok: true, registration: reg };
    if (!nearest || Object.keys(verdict.diff).length < Object.keys(nearest.diff).length) nearest = { ...verdict, reg };
  }
  return nearest ? { ok: false, reason: nearest.reason, diff: nearest.diff } : null;
}

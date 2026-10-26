import { extractArchive } from "@packserver/core/canonical";
import { sha256Hex } from "@packserver/core/index";
import { checkIntegrity } from "@packserver/core/publishing";
import { scorePack } from "@packserver/core/score";
import {
  applyThresholds, buildReport, fetchRelease, findingFactory, loadFindings, MirrorError, readMirrorManifest, SandboxAReport, SandboxBReport, SandboxBRequest, selectEngines,
  staticOnly, stepOfRule, type StepName,
} from "@packserver/core/validation";
import { syncClock, type R2 } from "@packserver/ports";
import { loadRules, RULES_VERSIONS } from "@packserver/rules";
import { Finding, TreeFetchRequest, TreeFetchResponse, type Capability, type PreInstallManifest, type Provenance, type SignalName } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { lookupsFor, newestPublished, previousPromoted } from "./lookups";
import { milestone } from "./milestones";
import { getFindings, getJson, putFindings, putJson, runKeys } from "./report";
import { finishRun, packId, readRun, type RunInput } from "./run";

/** The key of the feature flag that pins the newest cn release and the digest of every release the validator may hand to container B. */
export const ENGINE_PIN_FLAG = "cn_engine_pin";
const MAX_CANONICAL_BYTES = 21 * 1024 * 1024;
const STATIC_STEPS = ["manifest", "text", "capabilities"] as const satisfies readonly StepName[];

/** Retried by the Workflow; the pipeline turns the last failure into verdict `error` with the code as its reason. */
export class InfrastructureError extends Error {
  constructor(readonly code: `${string}.${string}`) {
    super(code);
  }
}

/** The register word a failure ends the run with; anything that is not one of ours is a platform fault. */
export const reasonOf = (e: unknown): string => (e instanceof Error && /^[a-z]+\.[a-z_]+$/.test(e.message) ? e.message : "infrastructure.error");

export interface Context {
  rt: ValidatorRuntime;
  runId: string;
  rules: string;
}

export interface Outcome {
  /** Nothing after this step may run: the findings so far are the run's findings. */
  stop: boolean;
  /** The run ends `error`, with this register word: the platform failed, or the same inputs would fail again. */
  infrastructure?: string;
  /** The run ends `fail` without a report, with this register word. */
  refused?: string;
}

const nowIso = async (rt: ValidatorRuntime): Promise<string> => {
  await syncClock(rt.ports.clock);
  return new Date(rt.ports.clock.now()).toISOString();
};

const reports = (rt: ValidatorRuntime): R2 => {
  const bucket = rt.ports.r2.VALIDATION_REPORTS;
  if (!bucket) throw new Error("the VALIDATION_REPORTS binding is missing");
  return bucket;
};

function stat(rt: ValidatorRuntime, name: SignalName, blobs: string[], doubles: number[] = []): void {
  rt.ports.stats.write({ name, blobs, doubles });
}

const worst = (findings: readonly Finding[]): string | null => {
  const f = findings.find((x) => x.class === "fail") ?? findings.find((x) => x.class === "hold") ?? findings[0];
  return f?.rule ?? null;
};

/** The step's findings and milestone together: the milestone is the commit point of the step's record. */
async function conclude(ctx: Context, step: StepName, findings: Finding[], started: number, extra: { detail?: string | null; failed?: boolean } = {}): Promise<void> {
  const { rt, runId } = ctx;
  await putFindings(reports(rt), runId, step, findings);
  const failed = extra.failed ?? findings.some((f) => f.class === "fail");
  await milestone(rt.ports.d1, runId, step, failed ? "fail" : "ok", extra.detail ?? worst(findings), await nowIso(rt));
  stat(rt, "validation.step", [step, failed ? "fail" : "ok"], [Date.now() - started]);
}

async function skipped(ctx: Context, step: StepName, detail: string): Promise<void> {
  await milestone(ctx.rt.ports.d1, ctx.runId, step, "skipped", detail, await nowIso(ctx.rt));
}

/** Reads the run and fixes the rules version it will be judged by, so every later step and retry agrees. */
export async function start(rt: ValidatorRuntime, runId: string): Promise<{ rules: string; startAfter: string; finished: boolean }> {
  const run = await readRun(rt.ports.d1, runId);
  const rules = RULES_VERSIONS.at(-1);
  if (!rules) throw new Error("no rules version");
  return { rules, startAfter: run.start_after, finished: run.status === "finished" };
}

/** Step 2, again: the staged object is still the one admission checked. */
export async function integrity(ctx: Context): Promise<Outcome> {
  const { rt } = ctx;
  const run = await readRun(rt.ports.d1, ctx.runId);
  const staging = rt.ports.r2.PACKS_STAGING;
  if (!staging) throw new Error("the PACKS_STAGING binding is missing");
  const head = await staging.head(run.staging_key);
  if (!head) throw new InfrastructureError("staging.object_missing");
  const checked = await checkIntegrity({ size: head.size, read: () => staging.get(run.staging_key) }, run.declared_sha256, sha256Hex);
  if (checked.ok) return { stop: false };
  return { stop: true, refused: checked.reason };
}

/** Step 3: container A, once. A refusal or a crash here is the archive's verdict and final; only a report the platform could not produce is retried. */
export async function extraction(ctx: Context): Promise<Outcome & { archiveReason?: string }> {
  const { rt, runId } = ctx;
  const started = Date.now();
  const run = await readRun(rt.ports.d1, runId);
  const bytes = await rt.ports.r2.PACKS_STAGING!.get(run.staging_key);
  if (!bytes) throw new InfrastructureError("staging.object_missing");

  const make = findingFactory(loadRules(ctx.rules));
  const newest = await newestPublished(rt.ports.d1, run);
  const request = {
    pack: packId(run),
    newest_version: newest,
    rules_version: ctx.rules,
    lookups: await lookupsFor(rt.ports.d1, run),
    previous_capabilities: await previousPromoted(rt.ports.d1, { public: rt.ports.r2.PACKS_PUBLIC!, private: rt.ports.r2.PACKS_PRIVATE! }, run, newest),
  };

  let answer;
  try {
    answer = await rt.ports.sandbox.inspect({ upload: bytes, request });
  } catch {
    const finding = make("archive.unsafe", { hint: "The archive was refused (extract-crash)." });
    await conclude(ctx, "extraction", [finding], started, { detail: "archive.unsafe" });
    return { stop: true, archiveReason: "archive.unsafe" };
  }
  const parsed = SandboxAReport.safeParse(answer.report);
  if (!parsed.success) throw new InfrastructureError("sandbox.report_invalid");
  const report = parsed.data;

  if (report.outcome === "error") throw new InfrastructureError("sandbox.a_failed");
  if (report.findings_truncated && !report.findings.some((f) => f.class === "fail")) throw new InfrastructureError("sandbox.findings_truncated");
  await putJson(reports(rt), runKeys.sandboxA(runId), report);

  if (report.outcome === "refused" && report.refusal) {
    const findings = report.findings.length > 0 ? report.findings : [make(report.refusal.reason, { hint: `The archive was refused (${report.refusal.code}).` })];
    await conclude(ctx, "extraction", findings, started, { detail: report.refusal.reason });
    stat(rt, "validation.step", ["extraction", report.refusal.reason]);
    return { stop: true, archiveReason: report.refusal.reason };
  }
  if (report.outcome === "timeout") {
    await conclude(ctx, "extraction", [make("sandbox.timeout", { hint: "Inspecting the archive took longer than the 5 minute limit." })], started, { detail: "sandbox.timeout" });
    stat(rt, "validation.sandbox_timeout", ["a"], [report.timings_ms.total]);
    return { stop: true };
  }

  const canonical = answer.canonical;
  if (!canonical || !report.canonical_sha256 || !report.tree_hash || report.round_trip_ok !== true) throw new InfrastructureError("sandbox.canonical_missing");
  if (canonical.byteLength > MAX_CANONICAL_BYTES || (await sha256Hex(canonical)) !== report.canonical_sha256) throw new InfrastructureError("sandbox.canonical_mismatch");
  await reports(rt).put(runKeys.canonical(runId), canonical, { content_type: "application/zstd" });
  await conclude(ctx, "extraction", [], started, { detail: null });
  return { stop: false };
}

/** Steps 4 to 6: the findings of sandbox A's report, each filed under the step that reports its rule. */
export async function staticStep(ctx: Context, step: (typeof STATIC_STEPS)[number], blocked: boolean): Promise<Outcome & { failed: boolean }> {
  if (blocked) {
    await skipped(ctx, step, "earlier-failure");
    return { stop: false, failed: false };
  }
  const started = Date.now();
  const report = await getJson<SandboxAReport>(reports(ctx.rt), runKeys.sandboxA(ctx.runId));
  const findings = report.findings.filter((f) => stepOfRule(f.rule) === step);
  await conclude(ctx, step, findings, started);
  return { stop: false, failed: findings.some((f) => f.class === "fail") };
}

/** Step 7: the committed form, written once before anything else runs; a second, different commit is refused. */
export async function canonical(ctx: Context, blocked: boolean): Promise<Outcome> {
  if (blocked) {
    await skipped(ctx, "canonical", "earlier-failure");
    return { stop: false };
  }
  const { rt, runId } = ctx;
  const started = Date.now();
  const report = await getJson<SandboxAReport>(reports(rt), runKeys.sandboxA(runId));
  if (!report.tree_hash || !report.canonical_sha256) throw new InfrastructureError("sandbox.canonical_missing");
  const at = await nowIso(rt);
  await rt.ports.d1.query(
    `update validation_runs set tree_hash = ?, canonical_sha256 = ?, canonical_key = ?, committed_at = ?, updated_at = ? where id = ? and tree_hash is null`,
    [report.tree_hash, report.canonical_sha256, runKeys.canonical(runId), at, at, runId],
  );
  const run = await readRun(rt.ports.d1, runId);
  if (run.tree_hash !== report.tree_hash || run.canonical_sha256 !== report.canonical_sha256) {
    throw new InfrastructureError("sandbox.commit_conflict");
  }
  await conclude(ctx, "canonical", [], started, { detail: null });
  return { stop: false };
}

interface EnginePin {
  newest: string;
  digests: Record<string, string>;
}

async function enginePin(rt: ValidatorRuntime): Promise<EnginePin> {
  const row = (await rt.ports.d1.query(`select value from feature_flags where key = ?`, [ENGINE_PIN_FLAG])).rows[0];
  if (!row) throw new InfrastructureError("engine.pin_missing");
  const pin = JSON.parse(String(row.value)) as Partial<EnginePin>;
  if (typeof pin.newest !== "string" || !pin.digests || typeof pin.digests !== "object") throw new InfrastructureError("engine.pin_malformed");
  return { newest: pin.newest, digests: pin.digests };
}

/** Step 8: container B, handed only the committed canonical archive and engine releases the registry fetched by pinned digest. */
export async function load(ctx: Context, blocked: boolean): Promise<Outcome> {
  if (blocked) {
    await skipped(ctx, "load", "earlier-failure");
    return { stop: false };
  }
  const { rt, runId } = ctx;
  const started = Date.now();
  const run = await readRun(rt.ports.d1, runId);
  const a = await getJson<SandboxAReport>(reports(rt), runKeys.sandboxA(runId));
  if (!run.tree_hash || run.tree_hash !== a.tree_hash) throw new InfrastructureError("sandbox.commit_missing");
  const canonicalBytes = await reports(rt).get(runKeys.canonical(runId));
  if (!canonicalBytes || (await sha256Hex(canonicalBytes)) !== run.canonical_sha256) throw new InfrastructureError("sandbox.canonical_mismatch");

  const minEngine = typeof a.manifest?.minEngineVersion === "string" ? a.manifest.minEngineVersion : null;
  if (minEngine === null) throw new InfrastructureError("engine.min_version_missing");
  const pin = await enginePin(rt);
  const ops = rt.ports.r2.OPS_BUCKET;
  if (!ops) throw new Error("the OPS_BUCKET binding is missing");

  let request: SandboxBRequest;
  const engines: Array<{ file: string; bytes: Uint8Array }> = [];
  try {
    const mirror = await readMirrorManifest({ get: (key) => ops.get(key) });
    const selection = selectEngines(mirror, pin.newest, minEngine);
    const wanted: Array<{ role: "newest" | "lowest"; version: string }> = [{ role: "newest", version: selection.newest }];
    if (selection.supported && selection.lowest !== selection.newest) wanted.push({ role: "lowest", version: selection.lowest });
    const listed: SandboxBRequest["engines"] = [];
    for (const w of wanted) {
      const sha256 = pin.digests[w.version];
      if (!sha256) throw new MirrorError("digest_unpinned", w.version);
      const bytes = await fetchRelease({ get: (key) => ops.get(key) }, mirror, w.version, sha256);
      const file = `${w.version}.tgz`;
      engines.push({ file, bytes });
      listed.push({ role: w.role, version: w.version, sha256, file });
    }
    request = SandboxBRequest.parse({ pack: packId(run), expected_tree_hash: run.tree_hash, min_engine_version: minEngine, oldest_engine_in_mirror: mirror.oldest, engines: listed });
  } catch (e) {
    throw new InfrastructureError(e instanceof MirrorError ? (`engine.mirror_${e.code}` as const) : "engine.mirror_unreadable");
  }

  const answer = await rt.ports.sandbox.run({ canonical: canonicalBytes, request, engines });
  const parsed = SandboxBReport.safeParse(answer.report);
  if (!parsed.success) throw new InfrastructureError("sandbox.report_invalid");
  await putJson(reports(rt), runKeys.sandboxB(runId), parsed.data);

  const outcome = loadFindings(parsed.data, findingFactory(loadRules(ctx.rules)));
  if (outcome.kind === "infrastructure") {
    if (outcome.code === "sandbox.tree_hash_mismatch") stat(rt, "validation.tree_hash_mismatch", [packId(run)]);
    if (outcome.retry) throw new InfrastructureError(outcome.code as `${string}.${string}`);
    await milestone(rt.ports.d1, runId, "load", "fail", outcome.code, await nowIso(rt));
    return { stop: true, infrastructure: outcome.code };
  }
  if (outcome.findings.some((f) => f.rule === "sandbox.timeout")) stat(rt, "validation.sandbox_timeout", ["b"], [parsed.data.timings_ms.total]);
  await conclude(ctx, "load", outcome.findings, started);
  return { stop: false };
}

interface Claims {
  repository_id: number | string;
  sha: string;
  repository: string;
  ref: string;
  event_name: string;
  run_id: string | number;
}

async function claimsOf(rt: ValidatorRuntime, run: RunInput): Promise<{ claims: Claims; path: string } | null> {
  if (run.source !== "oidc") return null;
  const row = (
    await rt.ports.d1.query(
      `select c.claims, t.path from upload_credentials c left join trusted_publishers t on t.id = c.trusted_publisher_id where c.id = ?`,
      [run.credential_id],
    )
  ).rows[0];
  if (!row?.claims) return null;
  return { claims: JSON.parse(String(row.claims)) as Claims, path: String(row.path ?? ".") };
}

/** Step 9: for an OIDC publish, the repository's tree at the claimed commit against the validated one. */
export async function source(ctx: Context, blocked: boolean): Promise<Outcome & { sourceVerified: boolean | null }> {
  if (blocked) {
    await skipped(ctx, "source", "earlier-failure");
    return { stop: false, sourceVerified: false };
  }
  const { rt, runId } = ctx;
  const started = Date.now();
  const run = await readRun(rt.ports.d1, runId);
  const claimed = await claimsOf(rt, run);
  if (!claimed || run.kind === "dry-run") {
    await skipped(ctx, "source", "no-repository-claim");
    return { stop: false, sourceVerified: false };
  }
  const make = findingFactory(loadRules(ctx.rules));
  const request = TreeFetchRequest.parse({ repository_id: Number(claimed.claims.repository_id), commit: claimed.claims.sha, path: claimed.path });
  const response = await rt.services.github.fetch("http://github.internal/internal/tree", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const parsed = TreeFetchResponse.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new InfrastructureError("github.unavailable");

  if (parsed.data.status === "found") {
    const verified = parsed.data.tree_hash === run.tree_hash;
    if (!verified) stat(rt, "publish.provenance_mismatch", [packId(run)]);
    const findings = verified ? [] : [make("provenance.tree_mismatch", { hint: "The repository tree at the claimed commit and path differs from the archive that was uploaded." })];
    await conclude(ctx, "source", findings, started, { detail: verified ? "verified" : "provenance.tree_mismatch" });
    return { stop: false, sourceVerified: verified };
  }
  stat(rt, "publish.source_unverified", [packId(run), parsed.data.status]);
  await conclude(ctx, "source", [make("provenance.source-unverified", { hint: "The repository tree at the claimed commit could not be fetched, so the source is not verified." })], started, {
    detail: `source.${parsed.data.status}`,
  });
  return { stop: false, sourceVerified: false };
}

export interface ProseRecord {
  implementation: string;
  question_set_version: string;
  model_version: string | null;
  cost_usd: number | null;
}

/** Step 10: only after every cheaper step has passed, and never for a synthetic scope. */
export async function proseScreen(ctx: Context, blocked: boolean): Promise<Outcome & { record: ProseRecord | null }> {
  const { rt, runId } = ctx;
  const started = Date.now();
  const run = await readRun(rt.ports.d1, runId);
  if (run.synthetic) {
    await skipped(ctx, "prose-screen", "synthetic");
    return { stop: false, record: null };
  }
  if (blocked) {
    await skipped(ctx, "prose-screen", "earlier-failure");
    return { stop: false, record: null };
  }
  if (run.kind === "dry-run" && !run.prose_screen) {
    await skipped(ctx, "prose-screen", "not-requested");
    return { stop: false, record: null };
  }
  const rules = loadRules(ctx.rules);
  const stepFive = await getFindings(reports(rt), runId, "text");
  const screen = staticOnly(stepFive);
  const result = await screen.screen([], rules.questions.version);
  await putFindings(reports(rt), runId, "prose-screen", result.findings);
  await putJson(reports(rt), `runs/${runId}/prose-screen.json`, result);
  await milestone(rt.ports.d1, runId, "prose-screen", "ok", result.implementation, await nowIso(rt));
  stat(rt, "validation.prose_screen", [result.implementation], [Date.now() - started]);
  return {
    stop: false,
    record: { implementation: result.implementation, question_set_version: result.question_set_version, model_version: result.model_version, cost_usd: result.cost_usd },
  };
}

/** Step 11: thresholds from the rules version over what the screen returned. */
export async function thresholds(ctx: Context): Promise<Outcome> {
  const { rt, runId } = ctx;
  const started = Date.now();
  const bytes = await reports(rt).get(`runs/${runId}/prose-screen.json`);
  if (!bytes) {
    await skipped(ctx, "thresholds", "no-prose-screen");
    return { stop: false };
  }
  const rules = loadRules(ctx.rules);
  const result = JSON.parse(new TextDecoder().decode(bytes));
  const make = findingFactory(rules);
  const applied = applyThresholds(result, [], rules, make);
  await putFindings(reports(rt), runId, "thresholds", applied.findings);
  await putJson(reports(rt), `runs/${runId}/admin.thresholds.json`, { tripped: applied.tripped });
  await milestone(rt.ports.d1, runId, "thresholds", applied.findings.some((f) => f.class === "hold") ? "ok" : "ok", worst(applied.findings), await nowIso(rt));
  stat(rt, "validation.step", ["thresholds", "ok"], [Date.now() - started]);
  return { stop: false };
}

const ALL_FINDING_STEPS: readonly StepName[] = ["extraction", ...STATIC_STEPS, "canonical", "load", "source", "prose-screen", "thresholds"];

export interface Verdicted {
  verdict: "pass" | "warn" | "hold" | "fail";
  reportKey: string;
  score: number | null;
}

/** Step 12: the verdict, the score from the committed tree, and the report; the one place a run is finished. */
export async function verdict(ctx: Context, facts: { sourceVerified: boolean; prose: ProseRecord | null; startedAt: string }): Promise<Verdicted> {
  const { rt, runId } = ctx;
  const started = Date.now();
  const run = await readRun(rt.ports.d1, runId);
  const bucket = reports(rt);
  const findings: Finding[] = [];
  for (const step of ALL_FINDING_STEPS) findings.push(...(await getFindings(bucket, runId, step)));
  const failedSteps = findings.some((f) => f.class === "fail");

  let score: number | null = null;
  let widening: boolean | null = null;
  const committed = run.tree_hash !== null;
  if (committed && !failedSteps) {
    const a = await getJson<SandboxAReport>(bucket, runKeys.sandboxA(runId));
    const bytes = await bucket.get(runKeys.canonical(runId));
    if (!bytes || (await sha256Hex(bytes)) !== run.canonical_sha256) throw new InfrastructureError("sandbox.canonical_mismatch");
    const tree = await extractArchive(bytes, { canonical: true });
    const caps = (a.capabilities ?? { capabilities: [], preinstall: null, widening: false }) as { capabilities: Capability[]; preinstall: PreInstallManifest | null; widening: boolean };
    widening = caps.widening;
    const claimed = await claimsOf(rt, run);
    const provenance: Provenance = claimed
      ? {
          source: "oidc",
          repository: claimed.claims.repository,
          repository_id: Number(claimed.claims.repository_id),
          commit: claimed.claims.sha,
          ref: claimed.claims.ref,
          event: claimed.claims.event_name,
          workflow_run: String(claimed.claims.run_id),
          path: claimed.path,
          source_verified: facts.sourceVerified,
        }
      : { source: "upload", source_verified: false };
    score = scorePack({ tree, capabilities: caps.capabilities, provenance, linkedPublicRepository: claimed !== null, publishedAdvisory: false, rulesVersion: ctx.rules }).total;
  }

  const finishedAt = await nowIso(rt);
  const steps = await stepRecords(rt, runId);
  const { report, verdict: v } = buildReport({
    runId,
    pack: packId(run),
    version: run.version,
    rulesVersion: ctx.rules,
    startedAt: facts.startedAt,
    finishedAt,
    steps,
    findings,
    treeHash: run.tree_hash,
    canonicalSha256: run.canonical_sha256,
    sourceVerified: facts.sourceVerified,
    proseScreen: facts.prose,
    score,
  });
  await putJson(bucket, runKeys.report(runId), report);
  const tripped = await bucket.get(`runs/${runId}/admin.thresholds.json`);
  await putJson(bucket, runKeys.admin(runId), { implementation: facts.prose?.implementation ?? null, thresholds: tripped ? JSON.parse(new TextDecoder().decode(tripped)) : null });
  await milestone(rt.ports.d1, runId, "verdict", v === "fail" ? "fail" : "ok", v, finishedAt);
  await finishRun(rt.ports.d1, runId, { verdict: v, reason: v === "fail" ? (worst(findings) ?? null) : null, reportKey: runKeys.report(runId), sourceVerified: facts.sourceVerified, widening, score, rulesVersion: ctx.rules }, finishedAt);
  stat(rt, "validation.verdict_distribution", [v, run.kind], [Date.now() - started]);
  stat(rt, v === "fail" ? "publish.failed" : "publish.validated", [run.kind, v]);
  return { verdict: v, reportKey: runKeys.report(runId), score };
}

async function stepRecords(rt: ValidatorRuntime, runId: string) {
  const rows = (await rt.ports.d1.query(`select step, outcome from validation_milestones where run_id = ? order by seq`, [runId])).rows;
  const names = new Set<string>(["extraction", "manifest", "text", "capabilities", "canonical", "load", "source", "prose-screen", "thresholds", "integrity", "admission"]);
  return rows
    .filter((r) => names.has(String(r.step)))
    .map((r) => ({
      step: String(r.step) as StepName,
      outcome: (r.outcome === "ok" ? "pass" : r.outcome === "fail" ? "fail" : "skipped") as "pass" | "fail" | "skipped",
      ms: 0,
    }));
}

/** The run ends without a verdict about the pack: a sandbox or the platform failed, or the same inputs would fail again. */
export async function fail(ctx: Context, reason: string): Promise<void> {
  const at = await nowIso(ctx.rt);
  await milestone(ctx.rt.ports.d1, ctx.runId, "verdict", "fail", reason, at);
  await finishRun(ctx.rt.ports.d1, ctx.runId, { verdict: "error", reason, reportKey: null, sourceVerified: null, widening: null, score: null, rulesVersion: ctx.rules }, at);
  stat(ctx.rt, "validation.verdict_distribution", ["error", reason]);
  stat(ctx.rt, "publish.failed", ["error", reason]);
}

/** The run ends `fail` before there is anything to report: the staged bytes are no longer the ones admission checked. */
export async function refuse(ctx: Context, reason: string): Promise<void> {
  const at = await nowIso(ctx.rt);
  await finishRun(ctx.rt.ports.d1, ctx.runId, { verdict: "fail", reason, reportKey: null, sourceVerified: null, widening: null, score: null, rulesVersion: ctx.rules }, at);
}

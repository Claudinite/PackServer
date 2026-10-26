import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { scopes } from "./scopes";

export const RUN_KINDS = ["publish", "dry-run"] as const;
export const RUN_SOURCES = ["oidc", "upload"] as const;
/** `queued` waits for `start_after` or for the validator to take it; `running` has been handed to the validator. */
export const RUN_STATUSES = ["queued", "running", "finished"] as const;
export const RUN_VERDICTS = ["pass", "warn", "hold", "fail", "error"] as const;
/** Why a run waits past the moment it was admitted. */
export const QUEUE_REASONS = ["soft-rate-limit", "sandbox-budget"] as const;
export const MILESTONE_OUTCOMES = ["ok", "fail", "skipped"] as const;

/**
 * One validation run: a publish or a dry-run of one staged object. The validator's workflow is
 * started with this row's id and reads everything else from here; it never carries bytes.
 */
export const validation_runs = sqliteTable(
  "validation_runs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: RUN_KINDS }).notNull(),
    source: text("source", { enum: RUN_SOURCES }).notNull(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    /** Without the scope. */
    pack_name: text("pack_name").notNull(),
    version: text("version").notNull(),
    /** Whose daily caps the run counts against: `user:<id>`, or `scope:<id>` for a run started by trusted publishing. */
    principal: text("principal").notNull(),
    /** One credential buys one run. */
    credential_id: text("credential_id").notNull(),
    staging_key: text("staging_key").notNull(),
    /** The SHA-256 the publisher declared for the uploaded bytes. */
    declared_sha256: text("declared_sha256").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    /** A dry-run may opt in to the prose screen. */
    prose_screen: integer("prose_screen", { mode: "boolean" }).notNull().default(false),
    /** Set from the scope's kind at admission: no prose screen, no human queue, expires after a day. */
    synthetic: integer("synthetic", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: RUN_STATUSES }).notNull(),
    verdict: text("verdict", { enum: RUN_VERDICTS }),
    /** A register word such as `integrity.sha256_mismatch` when the run failed before the validator took it. */
    reason: text("reason"),
    queued_reason: text("queued_reason", { enum: QUEUE_REASONS }),
    /** The validator does not start the run's steps before this instant. */
    start_after: text("start_after").notNull(),
    /** Set when the validator accepted the start; absent while it has not (or could not) be asked. */
    dispatched_at: text("dispatched_at"),
    dispatch_attempts: integer("dispatch_attempts").notNull().default(0),
    workflow_instance_id: text("workflow_instance_id"),
    /** Where the validator wrote the full report, once it has one. */
    report_key: text("report_key"),
    /** Whether this run is the one that counted its pack as new against the scope's daily cap. */
    counted_new_pack: integer("counted_new_pack", { mode: "boolean" }).notNull().default(false),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    finished_at: text("finished_at"),
    /** A synthetic run's version expires 24 hours after admission. */
    expires_at: text("expires_at"),
  },
  (t) => [
    uniqueIndex("validation_runs_credential_unique").on(t.credential_id),
    index("validation_runs_version_idx").on(t.scope_id, t.pack_name, t.version),
    index("validation_runs_principal_idx").on(t.principal, t.created_at),
    index("validation_runs_status_idx").on(t.status),
    check("validation_runs_kind_check", sql`${t.kind} in (${inList(RUN_KINDS)})`),
    check("validation_runs_source_check", sql`${t.source} in (${inList(RUN_SOURCES)})`),
    check("validation_runs_status_check", sql`${t.status} in (${inList(RUN_STATUSES)})`),
    check("validation_runs_verdict_check", sql`${t.verdict} is null or ${t.verdict} in (${inList(RUN_VERDICTS)})`),
    check("validation_runs_queue_reason_check", sql`${t.queued_reason} is null or ${t.queued_reason} in (${inList(QUEUE_REASONS)})`),
    check("validation_runs_size_check", sql`${t.size_bytes} >= 0`),
  ],
);

/** What a run has done so far, in order, so the dashboard shows live progress and a crashed run resumes. */
export const validation_milestones = sqliteTable(
  "validation_milestones",
  {
    run_id: text("run_id")
      .notNull()
      .references(() => validation_runs.id),
    seq: integer("seq").notNull(),
    step: text("step").notNull(),
    outcome: text("outcome", { enum: MILESTONE_OUTCOMES }).notNull(),
    /** A register word or short note; never publisher-written text. */
    detail: text("detail"),
    at: text("at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.run_id, t.seq] }),
    check("validation_milestones_outcome_check", sql`${t.outcome} in (${inList(MILESTONE_OUTCOMES)})`),
  ],
);

/** Sandbox minutes spent in one UTC day, registry-wide; written by the validator, read by admission. */
export const sandbox_usage = sqliteTable("sandbox_usage", {
  /** `YYYY-MM-DD`. */
  day: text("day").primaryKey(),
  minutes: real("minutes").notNull().default(0),
});

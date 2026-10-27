import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { sql } from "drizzle-orm";
import { VERSION_STATES } from "../shapes/domain";
import { scopes } from "./scopes";

export const PACK_VISIBILITIES = ["public", "private"] as const;


export const packs = sqliteTable(
  "packs",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    /** Without the scope. */
    name: text("name").notNull(),
    visibility: text("visibility", { enum: PACK_VISIBILITIES }).notNull(),
    created_at: text("created_at").notNull(),
    /** When an owner deleted the pack. A public pack stays removed; a private one can be restored for 7 days. */
    removed_at: text("removed_at"),
  },
  (t) => [
    uniqueIndex("packs_scope_name_unique").on(t.scope_id, t.name),
    check("packs_visibility_check", sql`${t.visibility} in (${inList(PACK_VISIBILITIES)})`),
  ],
);

/** Lean: the full inventory, provenance and report live in R2. */
export const pack_versions = sqliteTable(
  "pack_versions",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    version: text("version").notNull(),
    state: text("state", { enum: VERSION_STATES }).notNull(),
    /** The canonical archive's hash. */
    sha256: text("sha256").notNull(),
    /** The hash of the bytes the publisher uploaded; absent when it is unknown. */
    upload_sha256: text("upload_sha256"),
    size_bytes: integer("size_bytes").notNull(),
    /** Absent until promotion. */
    published_at: text("published_at"),
    verified: integer("verified", { mode: "boolean" }).notNull(),
    verified_domain: text("verified_domain"),
    verified_github_org: text("verified_github_org"),
    source_verified: integer("source_verified", { mode: "boolean" }).notNull(),
    min_engine_version: text("min_engine_version"),
    /** JSON array of requirement strings. */
    requires: text("requires"),
    source_commit: text("source_commit"),
    /** 0..100; absent until scored. */
    score: integer("score"),
    score_rules_version: text("score_rules_version"),
    /** JSON `{parts, cap}` of the latest rescore; absent while the score is the one `meta.json` records. */
    score_breakdown: text("score_breakdown"),
    report_key: text("report_key"),
    /** The pre-install manifest (JSON) the signed index entry carries; set at promotion. */
    preinstall: text("preinstall"),
    /** Why the version is not `active`, and for a revocation its security note; written by whatever changes the status. */
    status_reason: text("status_reason"),
    status_security: text("status_security"),
    /** When the status last left `active`; the scope index lists such a version for 180 days. */
    status_changed_at: text("status_changed_at"),
    /** The state a private pack's version had when its pack was deleted, which a restore puts back. */
    state_before_removal: text("state_before_removal"),
    /** When the removed version's stored objects were deleted and the CDN purged; null while that work is owed. */
    objects_deleted_at: text("objects_deleted_at"),
    objects_purged_at: text("objects_purged_at"),
  },
  (t) => [
    uniqueIndex("pack_versions_pack_version_unique").on(t.pack_id, t.version),
    index("pack_versions_state_idx").on(t.state),
    index("pack_versions_sha256_idx").on(t.sha256),
    index("pack_versions_upload_sha256_idx").on(t.upload_sha256),
    check("pack_versions_state_check", sql`${t.state} in (${inList(VERSION_STATES)})`),
    check("pack_versions_score_check", sql`${t.score} is null or (${t.score} >= 0 and ${t.score} <= 100)`),
  ],
);

/** Registry-wide switches, written only through the admin API. */
export const feature_flags = sqliteTable("feature_flags", {
  key: text("key").primaryKey(),
  /** JSON. */
  value: text("value").notNull(),
  /** A security flag is honoured only with an HMAC from an admin-only key. */
  security: integer("security", { mode: "boolean" }).notNull().default(false),
  updated_at: text("updated_at").notNull(),
  /** HMAC over key, value and `updated_at` under the admin-only key; a security flag without a verifying one is ignored. */
  mac: text("mac"),
});

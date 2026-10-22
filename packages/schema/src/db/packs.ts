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
    sha256: text("sha256").notNull(),
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
    report_key: text("report_key"),
  },
  (t) => [
    uniqueIndex("pack_versions_pack_version_unique").on(t.pack_id, t.version),
    index("pack_versions_state_idx").on(t.state),
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
});

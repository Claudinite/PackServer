import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { scopes } from "./scopes";
import { users } from "./users";

export const CREDENTIAL_SOURCES = ["oidc", "upload"] as const;
/** How long an uploaded object may wait: a bare dry-run an hour, anything with a draft or a run attached fourteen days. */
export const STAGING_LIFETIMES = ["dry-run", "draft"] as const;

/**
 * A repository, workflow and path allowed to publish one pack. The pack need not exist yet (a
 * pending registration reserves the name), so it is named, not referenced.
 */
export const trusted_publishers = sqliteTable(
  "trusted_publishers",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    /** Without the scope. */
    pack_name: text("pack_name").notNull(),
    /** GitHub's immutable numeric ids, as the OIDC token carries them (strings). */
    repository_id: text("repository_id").notNull(),
    repository_owner_id: text("repository_owner_id").notNull(),
    /** `owner/name` as last registered; display only, a rename does not invalidate the row. */
    repository: text("repository").notNull(),
    /** Path of the workflow file inside the repository. */
    workflow: text("workflow").notNull(),
    /** Absent when the registration names no environment. */
    environment: text("environment"),
    /** The path inside the repository that holds the pack. */
    path: text("path").notNull(),
    /** JSON array of ref patterns, each a full ref in which `*` stands for any run of characters but `/`. */
    refs: text("refs").notNull(),
    /** JSON array of allowed `event_name` values. */
    events: text("events").notNull(),
    /** A pending registration reserves the name until this instant. */
    pending_until: text("pending_until"),
    created_by: text("created_by").references(() => users.id),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    index("trusted_publishers_pack_idx").on(t.scope_id, t.pack_name),
    index("trusted_publishers_repository_idx").on(t.repository_id),
  ],
);

/**
 * One 15-minute right to stage one object for one pack version. The secret is shown once and
 * kept only as a hash; `used_at` is set by the single presign it buys.
 */
export const upload_credentials = sqliteTable(
  "upload_credentials",
  {
    /** The credential id that names the staging object. */
    id: text("id").primaryKey(),
    secret_hash: text("secret_hash").notNull(),
    source: text("source", { enum: CREDENTIAL_SOURCES }).notNull(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    pack_name: text("pack_name").notNull(),
    version: text("version").notNull(),
    /** The registration an OIDC credential was issued under. */
    trusted_publisher_id: text("trusted_publisher_id").references(() => trusted_publishers.id),
    /** The person a web upload acts for. */
    user_id: text("user_id").references(() => users.id),
    /** The verified token claims the version's provenance is read from; never client input. */
    claims: text("claims"),
    /** The token's `jti`: one token buys one credential. */
    oidc_jti: text("oidc_jti"),
    staging_key: text("staging_key").notNull(),
    lifetime: text("lifetime", { enum: STAGING_LIFETIMES }).notNull(),
    issued_at: text("issued_at").notNull(),
    expires_at: text("expires_at").notNull(),
    /** Absent until the credential has been spent on a presigned URL. */
    used_at: text("used_at"),
    /** The `Content-Length` the URL was signed for; after the upload is confirmed, the size of the object found. */
    size_bytes: integer("size_bytes"),
    /** Set when the client reported the upload complete and the object was found within its cap. */
    uploaded_at: text("uploaded_at"),
    /** When the staged object may be deleted; set when the URL is presigned. */
    object_expires_at: text("object_expires_at"),
    /** Set when the staged object has been deleted, so its bytes stop counting. */
    released_at: text("released_at"),
  },
  (t) => [
    uniqueIndex("upload_credentials_secret_hash_unique").on(t.secret_hash),
    uniqueIndex("upload_credentials_staging_key_unique").on(t.staging_key),
    uniqueIndex("upload_credentials_oidc_jti_unique").on(t.oidc_jti),
    index("upload_credentials_scope_idx").on(t.scope_id),
    check("upload_credentials_source_check", sql`${t.source} in (${inList(CREDENTIAL_SOURCES)})`),
    check("upload_credentials_lifetime_check", sql`${t.lifetime} in (${inList(STAGING_LIFETIMES)})`),
    check("upload_credentials_size_check", sql`${t.size_bytes} is null or ${t.size_bytes} >= 0`),
  ],
);

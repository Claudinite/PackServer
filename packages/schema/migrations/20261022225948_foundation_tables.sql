CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_credential_id_unique` ON `credentials` (`credential_id`);--> statement-breakpoint
CREATE INDEX `credentials_user_idx` ON `credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`login` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_subject_unique` ON `identities` (`provider`,`provider_user_id`);--> statement-breakpoint
CREATE INDEX `identities_user_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `session_revocations` (
	`sid_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`revoked_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_revocations_user_idx` ON `session_revocations` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text,
	`display_name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE TABLE `retired_names` (
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`retired_at` text NOT NULL,
	PRIMARY KEY(`kind`, `name`),
	CONSTRAINT "retired_names_kind_check" CHECK("retired_names"."kind" in ('scope', 'pack', 'version'))
);
--> statement-breakpoint
CREATE TABLE `scope_members` (
	`scope_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`scope_id`, `user_id`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scope_members_user_idx` ON `scope_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`verified_domain` text,
	`verified_github_org` text,
	`created_at` text NOT NULL,
	CONSTRAINT "scopes_kind_check" CHECK("scopes"."kind" in ('user', 'org')),
	CONSTRAINT "scopes_state_check" CHECK("scopes"."state" in ('active', 'held'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scopes_name_unique` ON `scopes` (`name`);--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`security` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pack_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`version` text NOT NULL,
	`state` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`published_at` text,
	`verified` integer NOT NULL,
	`verified_domain` text,
	`verified_github_org` text,
	`source_verified` integer NOT NULL,
	`min_engine_version` text,
	`requires` text,
	`source_commit` text,
	`score` integer,
	`score_rules_version` text,
	`report_key` text,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pack_versions_state_check" CHECK("pack_versions"."state" in ('pending', 'approved', 'active', 'deprecated', 'yanked', 'quarantined', 'revoked', 'removed')),
	CONSTRAINT "pack_versions_score_check" CHECK("pack_versions"."score" is null or ("pack_versions"."score" >= 0 and "pack_versions"."score" <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pack_versions_pack_version_unique` ON `pack_versions` (`pack_id`,`version`);--> statement-breakpoint
CREATE INDEX `pack_versions_state_idx` ON `pack_versions` (`state`);--> statement-breakpoint
CREATE TABLE `packs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`visibility` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "packs_visibility_check" CHECK("packs"."visibility" in ('public', 'private'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packs_scope_name_unique` ON `packs` (`scope_id`,`name`);
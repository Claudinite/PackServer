CREATE TABLE `effective_access` (
	`pack_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`action` text NOT NULL,
	`private_repos_only` integer NOT NULL,
	`grant_id` text NOT NULL,
	PRIMARY KEY(`pack_id`, `principal_type`, `principal_id`, `action`),
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "effective_access_principal_type_check" CHECK("effective_access"."principal_type" in ('github_account')),
	CONSTRAINT "effective_access_action_check" CHECK("effective_access"."action" in ('read'))
);
--> statement-breakpoint
CREATE INDEX `effective_access_principal_idx` ON `effective_access` (`principal_type`,`principal_id`,`action`);--> statement-breakpoint
CREATE TABLE `fetch_log` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`version_id` text,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`caller` text NOT NULL,
	`caller_hash` text,
	`account_id` text,
	`repository` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fetch_log_kind_check" CHECK("fetch_log"."kind" in ('index', 'download')),
	CONSTRAINT "fetch_log_outcome_check" CHECK("fetch_log"."outcome" in ('served', 'denied')),
	CONSTRAINT "fetch_log_caller_check" CHECK("fetch_log"."caller" in ('oidc', 'session', 'device', 'token'))
);
--> statement-breakpoint
CREATE INDEX `fetch_log_pack_at_idx` ON `fetch_log` (`pack_id`,`at`);--> statement-breakpoint
CREATE INDEX `fetch_log_at_idx` ON `fetch_log` (`at`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`action` text NOT NULL,
	`private_repos_only` integer NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grants_principal_type_check" CHECK("grants"."principal_type" in ('github_account')),
	CONSTRAINT "grants_action_check" CHECK("grants"."action" in ('read'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_pack_principal_unique` ON `grants` (`pack_id`,`principal_type`,`principal_id`,`action`);
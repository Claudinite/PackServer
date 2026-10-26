PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `scopes_before_synthetic` AS SELECT * FROM `scopes`;--> statement-breakpoint
DROP TABLE `scopes`;--> statement-breakpoint
CREATE TABLE `scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`verified_domain` text,
	`verified_github_org` text,
	`created_at` text NOT NULL,
	CONSTRAINT "scopes_kind_check" CHECK("scopes"."kind" in ('user', 'org', 'synthetic')),
	CONSTRAINT "scopes_state_check" CHECK("scopes"."state" in ('active', 'held'))
);--> statement-breakpoint
INSERT INTO `scopes`(`id`, `name`, `kind`, `state`, `verified_domain`, `verified_github_org`, `created_at`) SELECT `id`, `name`, `kind`, `state`, `verified_domain`, `verified_github_org`, `created_at` FROM `scopes_before_synthetic`;--> statement-breakpoint
DROP TABLE `scopes_before_synthetic`;--> statement-breakpoint
CREATE UNIQUE INDEX `scopes_name_unique` ON `scopes` (`name`);

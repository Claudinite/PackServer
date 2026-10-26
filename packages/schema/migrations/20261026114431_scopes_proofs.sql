CREATE TABLE `domain_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`domain` text NOT NULL,
	`token` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`method` text,
	`created_at` text NOT NULL,
	`proven_at` text,
	`last_checked_at` text,
	`failed_since` text,
	`warned_at` text,
	`ended_at` text,
	`transferred_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "domain_challenges_state_check" CHECK("domain_challenges"."state" in ('pending', 'proven', 'lapsed', 'moved')),
	CONSTRAINT "domain_challenges_method_check" CHECK("domain_challenges"."method" is null or "domain_challenges"."method" in ('txt', 'well-known'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_challenges_one_holder` ON `domain_challenges` (`domain`) WHERE "domain_challenges"."state" = 'proven';--> statement-breakpoint
CREATE UNIQUE INDEX `domain_challenges_one_pending` ON `domain_challenges` (`scope_id`,`domain`) WHERE "domain_challenges"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `domain_challenges_scope_idx` ON `domain_challenges` (`scope_id`,`state`);--> statement-breakpoint
CREATE INDEX `domain_challenges_domain_idx` ON `domain_challenges` (`domain`,`ended_at`);--> statement-breakpoint
CREATE TABLE `github_org_proofs` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`org_login` text NOT NULL,
	`method` text NOT NULL,
	`installation_id` integer,
	`proven_at` text NOT NULL,
	`alerted_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "github_org_proofs_method_check" CHECK("github_org_proofs"."method" in ('app', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_org_proofs_org_unique` ON `github_org_proofs` (`org_login`);--> statement-breakpoint
CREATE TABLE `scope_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`claimant_scope_id` text NOT NULL,
	`domain` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`held_scope` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimant_scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scope_disputes_state_check" CHECK("scope_disputes"."state" in ('open', 'resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scope_disputes_pair_unique` ON `scope_disputes` (`scope_id`,`claimant_scope_id`);--> statement-breakpoint
CREATE INDEX `scope_disputes_scope_idx` ON `scope_disputes` (`scope_id`,`state`);--> statement-breakpoint
CREATE TABLE `scope_policies` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`mfa` text DEFAULT 'off' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scope_policies_mfa_check" CHECK("scope_policies"."mfa" in ('off', 'mfa', 'passkeys'))
);
--> statement-breakpoint
ALTER TABLE `vp_applications` ADD `decided_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `vp_applications` ADD `denial_reason` text;--> statement-breakpoint
ALTER TABLE `vp_applications` ADD `renewable_at` text;--> statement-breakpoint
ALTER TABLE `vp_applications` ADD `basis` text;--> statement-breakpoint
CREATE UNIQUE INDEX `vp_applications_one_pending` ON `vp_applications` (`scope_id`) WHERE "vp_applications"."state" = 'pending';
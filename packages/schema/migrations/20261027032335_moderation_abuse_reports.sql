CREATE TABLE `abuse_reporter_blocks` (
	`reporter_id` text PRIMARY KEY NOT NULL,
	`blocked_by` text NOT NULL,
	`blocked_at` text NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `abuse_reporter_flags` (
	`reporter_id` text NOT NULL,
	`flagged_by` text NOT NULL,
	`pack_id` text NOT NULL,
	`flagged_at` text NOT NULL,
	PRIMARY KEY(`reporter_id`, `flagged_by`),
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flagged_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `abuse_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`pack_id` text,
	`version` text,
	`reporter_id` text NOT NULL,
	`category` text NOT NULL,
	`details` text NOT NULL,
	`details_key` text NOT NULL,
	`prioritised_at` text,
	`collapsed_into` text,
	`state` text DEFAULT 'open' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "abuse_reports_target_check" CHECK("abuse_reports"."target_kind" in ('pack', 'review', 'profile')),
	CONSTRAINT "abuse_reports_category_check" CHECK("abuse_reports"."category" in ('malware', 'prompt_injection', 'secrets_leak', 'impersonation', 'spam', 'ip_infringement', 'other')),
	CONSTRAINT "abuse_reports_state_check" CHECK("abuse_reports"."state" in ('open', 'actioned', 'dismissed'))
);
--> statement-breakpoint
CREATE INDEX `abuse_reports_pack_idx` ON `abuse_reports` (`pack_id`,`version`,`state`);--> statement-breakpoint
CREATE INDEX `abuse_reports_target_idx` ON `abuse_reports` (`target_kind`,`target_id`,`details_key`);--> statement-breakpoint
CREATE INDEX `abuse_reports_reporter_idx` ON `abuse_reports` (`reporter_id`,`decided_at`);--> statement-breakpoint
CREATE INDEX `abuse_reports_filed_idx` ON `abuse_reports` (`reporter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `abuse_reports_open_idx` ON `abuse_reports` (`state`,`prioritised_at`);--> statement-breakpoint
CREATE TABLE `abuse_standing_losses` (
	`reporter_id` text PRIMARY KEY NOT NULL,
	`lost_at` text NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `comment_removals` (
	`comment_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`removed_by` text NOT NULL,
	`removed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dmca_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`complainant` text NOT NULL,
	`state` text DEFAULT 'removed' NOT NULL,
	`counter_notice` text,
	`counter_filed_at` text,
	`counter_filed_by` text,
	`suit_notified_at` text,
	`restored_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `moderation_actions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counter_filed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "dmca_cases_state_check" CHECK("dmca_cases"."state" in ('removed', 'counter_filed', 'restored', 'suit_filed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmca_cases_action_unique` ON `dmca_cases` (`action_id`);--> statement-breakpoint
CREATE INDEX `dmca_cases_state_idx` ON `dmca_cases` (`state`,`counter_filed_at`);--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`pack_id` text,
	`version` text,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`trigger` text NOT NULL,
	`actor` text NOT NULL,
	`taken_at` text NOT NULL,
	`restored_at` text,
	`from_state` text,
	`from_reason` text,
	`to_state` text,
	`to_reason` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "moderation_actions_kind_check" CHECK("moderation_actions"."kind" in ('quarantine', 'yank', 'dmca_removal', 'hide_pack', 'suspend')),
	CONSTRAINT "moderation_actions_trigger_check" CHECK("moderation_actions"."trigger" in ('report_standing', 'judge', 'admin', 'dmca'))
);
--> statement-breakpoint
CREATE INDEX `moderation_actions_version_idx` ON `moderation_actions` (`pack_id`,`version`,`taken_at`);--> statement-breakpoint
CREATE INDEX `moderation_actions_scope_idx` ON `moderation_actions` (`scope_id`,`kind`);--> statement-breakpoint
CREATE TABLE `moderation_appeals` (
	`action_id` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`submitted_by` text NOT NULL,
	`submitted_at` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	FOREIGN KEY (`action_id`) REFERENCES `moderation_actions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "moderation_appeals_state_check" CHECK("moderation_appeals"."state" in ('open', 'upheld', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `moderation_appeals_open_idx` ON `moderation_appeals` (`state`,`submitted_at`);
CREATE TABLE `rescan_passes` (
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`cursor` text,
	`versions` integer DEFAULT 0 NOT NULL,
	`findings` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`kind`, `trigger`),
	CONSTRAINT "rescan_passes_kind_check" CHECK("rescan_passes"."kind" in ('rules', 'domains', 'pipeline'))
);
--> statement-breakpoint
CREATE TABLE `rescan_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`trigger` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `validation_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `pack_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rescan_runs_pending_idx` ON `rescan_runs` (`applied_at`);--> statement-breakpoint
CREATE TABLE `url_domain_states` (
	`domain` text PRIMARY KEY NOT NULL,
	`resolves` integer NOT NULL,
	`checked_trigger` text NOT NULL,
	`changed_trigger` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `version_warnings` (
	`version_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`detected_at` text NOT NULL,
	PRIMARY KEY(`version_id`, `kind`, `subject`),
	FOREIGN KEY (`version_id`) REFERENCES `pack_versions`(`id`) ON UPDATE no action ON DELETE no action
);

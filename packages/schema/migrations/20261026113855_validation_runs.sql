CREATE TABLE `sandbox_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`minutes` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `validation_milestones` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`step` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`at` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `validation_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "validation_milestones_outcome_check" CHECK("validation_milestones"."outcome" in ('ok', 'fail', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE `validation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`scope_id` text NOT NULL,
	`pack_name` text NOT NULL,
	`version` text NOT NULL,
	`principal` text NOT NULL,
	`credential_id` text NOT NULL,
	`staging_key` text NOT NULL,
	`declared_sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`prose_screen` integer DEFAULT false NOT NULL,
	`synthetic` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`verdict` text,
	`reason` text,
	`queued_reason` text,
	`start_after` text NOT NULL,
	`dispatched_at` text,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`workflow_instance_id` text,
	`report_key` text,
	`counted_new_pack` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	`expires_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "validation_runs_kind_check" CHECK("validation_runs"."kind" in ('publish', 'dry-run')),
	CONSTRAINT "validation_runs_source_check" CHECK("validation_runs"."source" in ('oidc', 'upload')),
	CONSTRAINT "validation_runs_status_check" CHECK("validation_runs"."status" in ('queued', 'running', 'finished')),
	CONSTRAINT "validation_runs_verdict_check" CHECK("validation_runs"."verdict" is null or "validation_runs"."verdict" in ('pass', 'warn', 'hold', 'fail', 'error')),
	CONSTRAINT "validation_runs_queue_reason_check" CHECK("validation_runs"."queued_reason" is null or "validation_runs"."queued_reason" in ('soft-rate-limit', 'sandbox-budget')),
	CONSTRAINT "validation_runs_size_check" CHECK("validation_runs"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `validation_runs_credential_unique` ON `validation_runs` (`credential_id`);--> statement-breakpoint
CREATE INDEX `validation_runs_version_idx` ON `validation_runs` (`scope_id`,`pack_name`,`version`);--> statement-breakpoint
CREATE INDEX `validation_runs_principal_idx` ON `validation_runs` (`principal`,`created_at`);--> statement-breakpoint
CREATE INDEX `validation_runs_status_idx` ON `validation_runs` (`status`);
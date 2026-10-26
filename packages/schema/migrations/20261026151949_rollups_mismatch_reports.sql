CREATE TABLE `fetch_days` (
	`pack_id` text NOT NULL,
	`version` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`caller` text NOT NULL,
	`weight` integer NOT NULL,
	PRIMARY KEY(`pack_id`, `version`, `day`, `caller`),
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fetch_days_kind_check" CHECK("fetch_days"."kind" in ('public', 'private')),
	CONSTRAINT "fetch_days_weight_check" CHECK("fetch_days"."weight" >= 1)
);
--> statement-breakpoint
CREATE INDEX `fetch_days_day_idx` ON `fetch_days` (`day`);--> statement-breakpoint
CREATE TABLE `hash_mismatch_cases` (
	`pack_id` text NOT NULL,
	`version` text NOT NULL,
	`trigger` text NOT NULL,
	`opened_at` text NOT NULL,
	`paged_at` text NOT NULL,
	PRIMARY KEY(`pack_id`, `version`),
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hash_mismatch_cases_trigger_check" CHECK("hash_mismatch_cases"."trigger" in ('reports', 'server', 'review'))
);
--> statement-breakpoint
CREATE TABLE `hash_mismatch_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`version` text NOT NULL,
	`kind` text NOT NULL,
	`reporter_id` text,
	`expected` text NOT NULL,
	`observed` text NOT NULL,
	`reported_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hash_mismatch_reports_kind_check" CHECK("hash_mismatch_reports"."kind" in ('hash', 'signature'))
);
--> statement-breakpoint
CREATE INDEX `hash_mismatch_reports_version_idx` ON `hash_mismatch_reports` (`pack_id`,`version`,`reported_at`);--> statement-breakpoint
CREATE TABLE `pack_fetch_stats` (
	`pack_id` text PRIMARY KEY NOT NULL,
	`distinct_30d` integer NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rollup_files` (
	`job` text NOT NULL,
	`object_key` text NOT NULL,
	`processed_at` text NOT NULL,
	PRIMARY KEY(`job`, `object_key`)
);
--> statement-breakpoint
CREATE TABLE `rollup_runs` (
	`job` text NOT NULL,
	`hour` text NOT NULL,
	`capped` integer DEFAULT false NOT NULL,
	`files` integer NOT NULL,
	`rows` integer NOT NULL,
	`completed_at` text NOT NULL,
	PRIMARY KEY(`job`, `hour`)
);

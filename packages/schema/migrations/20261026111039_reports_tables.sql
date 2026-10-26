CREATE TABLE `advisories` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`report_id` text NOT NULL,
	`summary` text NOT NULL,
	`severity` text NOT NULL,
	`fixed_in` text,
	`published_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advisories_report_unique` ON `advisories` (`report_id`);--> statement-breakpoint
CREATE INDEX `advisories_pack_idx` ON `advisories` (`pack_id`);--> statement-breakpoint
CREATE TABLE `advisory_versions` (
	`advisory_id` text NOT NULL,
	`pack_id` text NOT NULL,
	`version` text NOT NULL,
	PRIMARY KEY(`advisory_id`, `version`),
	FOREIGN KEY (`advisory_id`) REFERENCES `advisories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `advisory_versions_pack_idx` ON `advisory_versions` (`pack_id`,`version`);--> statement-breakpoint
CREATE TABLE `pack_security_contacts` (
	`pack_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `report_attachment_chunks` (
	`attachment_id` text NOT NULL,
	`seq` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`attachment_id`, `seq`),
	FOREIGN KEY (`attachment_id`) REFERENCES `report_attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `report_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text,
	`uploader_id` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`disposition` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "report_attachments_disposition_check" CHECK("report_attachments"."disposition" in ('inline', 'attachment')),
	CONSTRAINT "report_attachments_size_check" CHECK("report_attachments"."size_bytes" >= 0 and "report_attachments"."size_bytes" <= 5242880)
);
--> statement-breakpoint
CREATE INDEX `report_attachments_report_idx` ON `report_attachments` (`report_id`);--> statement-breakpoint
CREATE INDEX `report_attachments_uploader_idx` ON `report_attachments` (`uploader_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `report_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`recipient` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE INDEX `report_notices_unsent_idx` ON `report_notices` (`sent_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` text NOT NULL,
	`type` text,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`repro` text NOT NULL,
	`environment` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`fixed_in` text,
	`route` text NOT NULL,
	`issue_repository` text,
	`issue_url` text,
	`disclosure_deadline` text,
	`reminder_sent_at` text,
	`expired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reports_kind_check" CHECK("reports"."kind" in ('bug', 'security')),
	CONSTRAINT "reports_status_check" CHECK("reports"."status" in ('open', 'acknowledged', 'fixed', 'wont_fix', 'duplicate')),
	CONSTRAINT "reports_type_check" CHECK("reports"."type" is null or "reports"."type" in ('crash', 'wrong_behaviour', 'docs', 'compatibility', 'other')),
	CONSTRAINT "reports_severity_check" CHECK("reports"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "reports_route_check" CHECK("reports"."route" in ('github_issue', 'inbox', 'security_contact', 'registry_security')),
	CONSTRAINT "reports_timer_check" CHECK(("reports"."kind" = 'security') = ("reports"."disclosure_deadline" is not null))
);
--> statement-breakpoint
CREATE INDEX `reports_pack_idx` ON `reports` (`pack_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_reporter_idx` ON `reports` (`reporter_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_deadline_idx` ON `reports` (`kind`,`disclosure_deadline`);--> statement-breakpoint
CREATE UNIQUE INDEX `reports_issue_url_unique` ON `reports` (`issue_url`);
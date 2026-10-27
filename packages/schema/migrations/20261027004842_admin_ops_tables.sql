CREATE TABLE `blocked_sources` (
	`source` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`blocked_by` text NOT NULL,
	`blocked_at` text NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE TABLE `page_acknowledgements` (
	`id` text PRIMARY KEY NOT NULL,
	`page` text NOT NULL,
	`acknowledged_by` text NOT NULL,
	`acknowledged_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `page_acknowledgements_page_idx` ON `page_acknowledgements` (`page`,`acknowledged_at`);
CREATE TABLE `notice_deliveries` (
	`dedupe_key` text PRIMARY KEY NOT NULL,
	`sent_at` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notice_deliveries_sent_idx` ON `notice_deliveries` (`sent_at`);--> statement-breakpoint
CREATE TABLE `signed_documents` (
	`doc_key` text PRIMARY KEY NOT NULL,
	`serial` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_hash` text NOT NULL,
	`signed_at` text NOT NULL
);

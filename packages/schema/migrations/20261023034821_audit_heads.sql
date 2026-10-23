CREATE TABLE `audit_heads` (
	`day` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`hash` text NOT NULL,
	`batch_key` text NOT NULL,
	`log_index` integer NOT NULL,
	`anchored_hash` text NOT NULL,
	`anchored_at` text NOT NULL
);

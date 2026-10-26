CREATE TABLE `pack_publish_settings` (
	`scope_id` text NOT NULL,
	`pack_name` text NOT NULL,
	`trusted_only` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope_id`, `pack_name`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `publisher_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`pack_name` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`caused_by` text,
	`consumed_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caused_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publisher_changes_kind_check" CHECK("publisher_changes"."kind" in ('maintainer-added', 'trusted-publisher', 'transfer-accepted', 'dormant'))
);
--> statement-breakpoint
CREATE INDEX `publisher_changes_pack_idx` ON `publisher_changes` (`scope_id`,`pack_name`,`consumed_at`);
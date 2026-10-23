CREATE TABLE `recent_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target` text,
	`user_id` text,
	`scope_id` text,
	`ip_hash` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `recent_activity_user_at_idx` ON `recent_activity` (`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `recent_activity_scope_at_idx` ON `recent_activity` (`scope_id`,`at`);--> statement-breakpoint
CREATE INDEX `recent_activity_at_idx` ON `recent_activity` (`at`);
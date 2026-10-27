CREATE TABLE `lifecycle_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pack_id` text NOT NULL,
	`version` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`audience` text NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lifecycle_notices_action_check" CHECK("lifecycle_notices"."action" in ('yanked', 'deprecated')),
	CONSTRAINT "lifecycle_notices_audience_check" CHECK("lifecycle_notices"."audience" in ('stargazer', 'reporter'))
);
--> statement-breakpoint
CREATE INDEX `lifecycle_notices_unsent_idx` ON `lifecycle_notices` (`sent_at`);--> statement-breakpoint
CREATE TABLE `star_digest_optins` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

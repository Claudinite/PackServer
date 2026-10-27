CREATE TABLE `authenticated_downloads` (
	`pack_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_at` text NOT NULL,
	PRIMARY KEY(`pack_id`, `user_id`),
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `authenticated_downloads_last_idx` ON `authenticated_downloads` (`last_at`);--> statement-breakpoint
CREATE TABLE `community_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "community_notices_kind_check" CHECK("community_notices"."kind" in ('review-removed'))
);
--> statement-breakpoint
CREATE INDEX `community_notices_unsent_idx` ON `community_notices` (`sent_at`);--> statement-breakpoint
CREATE TABLE `community_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pack_ratings` (
	`pack_id` text PRIMARY KEY NOT NULL,
	`review_count` integer NOT NULL,
	`verified_count` integer NOT NULL,
	`shown` real NOT NULL,
	`ranked` real NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `review_flags` (
	`review_id` text PRIMARY KEY NOT NULL,
	`flagged_by` text NOT NULL,
	`flagged_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flagged_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_flags_open_idx` ON `review_flags` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`user_id` text NOT NULL,
	`rating` integer NOT NULL,
	`body` text NOT NULL,
	`version` text NOT NULL,
	`verified_adoption` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`reply_body` text,
	`reply_by` text,
	`replied_at` text,
	`hidden_at` text,
	`hidden_reason` text,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_rating_check" CHECK("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_reply_check" CHECK(("reviews"."reply_body" is null) = ("reviews"."replied_at" is null)),
	CONSTRAINT "reviews_hidden_check" CHECK(("reviews"."hidden_at" is null) = ("reviews"."hidden_reason" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_pack_user_unique` ON `reviews` (`pack_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `reviews_user_time_idx` ON `reviews` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `star_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`started_at` text NOT NULL,
	`window_start` text NOT NULL,
	`ends_at` text NOT NULL,
	`burst_stars` integer NOT NULL,
	`daily_average` real NOT NULL,
	`reviewed_at` text,
	`released_at` text,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `star_holds_pack_idx` ON `star_holds` (`pack_id`,`ends_at`);--> statement-breakpoint
CREATE INDEX `star_holds_open_idx` ON `star_holds` (`reviewed_at`);--> statement-breakpoint
CREATE TABLE `stars` (
	`pack_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`pack_id`, `user_id`),
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stars_pack_time_idx` ON `stars` (`pack_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `stars_user_idx` ON `stars` (`user_id`);
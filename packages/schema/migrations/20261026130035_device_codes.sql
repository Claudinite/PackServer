CREATE TABLE `device_codes` (
	`device_hash` text PRIMARY KEY NOT NULL,
	`user_code_hash` text NOT NULL,
	`state` text NOT NULL,
	`country` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`interval_s` integer NOT NULL,
	`last_poll_at` integer,
	`user_id` text,
	`sid_hash` text,
	`session_expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "device_codes_state_check" CHECK("device_codes"."state" in ('pending', 'approved', 'denied', 'collected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_unique` ON `device_codes` (`user_code_hash`);--> statement-breakpoint
CREATE INDEX `device_codes_expires_idx` ON `device_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `device_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sid_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `device_tokens_expires_idx` ON `device_tokens` (`expires_at`);
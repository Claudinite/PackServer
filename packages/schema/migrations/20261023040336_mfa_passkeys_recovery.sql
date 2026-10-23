CREATE TABLE `assertion_failures` (
	`user_id` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`window_started_at` text NOT NULL,
	`locked_until` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `assertion_grants` (
	`grant_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sid_hash` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`method` text NOT NULL,
	`credential_id` text,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assertion_grants_expires_idx` ON `assertion_grants` (`expires_at`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` text,
	PRIMARY KEY(`user_id`, `code_hash`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recovery_sets` (
	`user_id` text PRIMARY KEY NOT NULL,
	`generated_at` text NOT NULL,
	`saved_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`challenge` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`sid_hash` text,
	`action` text,
	`target` text,
	`payload` text,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
ALTER TABLE `credentials` ADD `hold_until` text;--> statement-breakpoint
ALTER TABLE `credentials` ADD `transports` text;
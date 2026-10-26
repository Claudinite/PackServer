CREATE TABLE `account_tombstones` (
	`user_id` text PRIMARY KEY NOT NULL,
	`deleted_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `known_devices` (
	`user_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`label` text NOT NULL,
	`country` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `fingerprint`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recovery_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`requested_at` text NOT NULL,
	`ready_at` text NOT NULL,
	`state` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`link_hash` text,
	`link_expires_at` text,
	`completed_at` text,
	`cancel_hash` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recovery_requests_state_check" CHECK("recovery_requests"."state" in ('pending', 'approved', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `recovery_requests_user_idx` ON `recovery_requests` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_requests_link_unique` ON `recovery_requests` (`link_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_requests_cancel_unique` ON `recovery_requests` (`cancel_hash`);--> statement-breakpoint
CREATE TABLE `scope_mfa_policies` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scope_mfa_policies_policy_check" CHECK("scope_mfa_policies"."policy" in ('none', 'mfa', 'passkey'))
);

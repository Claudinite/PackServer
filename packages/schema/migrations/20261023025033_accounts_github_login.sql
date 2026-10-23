CREATE TABLE `github_org_admins` (
	`user_id` text NOT NULL,
	`github_org_id` text NOT NULL,
	`github_org_login` text NOT NULL,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `github_org_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `github_org_admins_org_idx` ON `github_org_admins` (`github_org_id`);--> statement-breakpoint
CREATE TABLE `user_emails` (
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `address`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_emails_address_unique` ON `user_emails` (`address`);
CREATE TABLE `trusted_publishers` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`pack_name` text NOT NULL,
	`repository_id` text NOT NULL,
	`repository_owner_id` text NOT NULL,
	`repository` text NOT NULL,
	`workflow` text NOT NULL,
	`environment` text,
	`path` text NOT NULL,
	`refs` text NOT NULL,
	`events` text NOT NULL,
	`pending_until` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trusted_publishers_pack_idx` ON `trusted_publishers` (`scope_id`,`pack_name`);--> statement-breakpoint
CREATE INDEX `trusted_publishers_repository_idx` ON `trusted_publishers` (`repository_id`);--> statement-breakpoint
CREATE TABLE `upload_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`source` text NOT NULL,
	`scope_id` text NOT NULL,
	`pack_name` text NOT NULL,
	`version` text NOT NULL,
	`trusted_publisher_id` text,
	`user_id` text,
	`claims` text,
	`staging_key` text NOT NULL,
	`lifetime` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`size_bytes` integer,
	`uploaded_at` text,
	`object_expires_at` text,
	`released_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trusted_publisher_id`) REFERENCES `trusted_publishers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "upload_credentials_source_check" CHECK("upload_credentials"."source" in ('oidc', 'upload')),
	CONSTRAINT "upload_credentials_lifetime_check" CHECK("upload_credentials"."lifetime" in ('dry-run', 'draft')),
	CONSTRAINT "upload_credentials_size_check" CHECK("upload_credentials"."size_bytes" is null or "upload_credentials"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_credentials_secret_hash_unique` ON `upload_credentials` (`secret_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `upload_credentials_staging_key_unique` ON `upload_credentials` (`staging_key`);--> statement-breakpoint
CREATE INDEX `upload_credentials_scope_idx` ON `upload_credentials` (`scope_id`);
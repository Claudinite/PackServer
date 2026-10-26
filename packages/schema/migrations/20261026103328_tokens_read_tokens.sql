CREATE TABLE `read_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`label` text,
	`scope_id` text NOT NULL,
	`pack_id` text,
	`cidr` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "read_tokens_kind_check" CHECK("read_tokens"."kind" in ('read')),
	CONSTRAINT "read_tokens_revoke_reason_check" CHECK("read_tokens"."revoked_reason" is null or "read_tokens"."revoked_reason" in ('owner', 'leak-reported'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `read_tokens_hash_unique` ON `read_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `read_tokens_user_idx` ON `read_tokens` (`user_id`);
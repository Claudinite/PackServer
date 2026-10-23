CREATE TABLE `pack_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`pack_name` text NOT NULL,
	`from_scope` text NOT NULL,
	`to_scope` text NOT NULL,
	`offered_by` text NOT NULL,
	`offered_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`state` text DEFAULT 'offered' NOT NULL,
	`resolved_by` text,
	`resolved_at` text,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`offered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pack_transfers_state_check" CHECK("pack_transfers"."state" in ('offered', 'accepted', 'lapsed'))
);
--> statement-breakpoint
CREATE INDEX `pack_transfers_pack_idx` ON `pack_transfers` (`pack_id`);--> statement-breakpoint
CREATE INDEX `pack_transfers_to_idx` ON `pack_transfers` (`to_scope`,`state`);--> statement-breakpoint
CREATE INDEX `pack_transfers_from_idx` ON `pack_transfers` (`from_scope`,`pack_name`);--> statement-breakpoint
CREATE TABLE `scope_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scope_invites_role_check" CHECK("scope_invites"."role" in ('owner', 'maintainer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scope_invites_scope_email_unique` ON `scope_invites` (`scope_id`,`email`);--> statement-breakpoint
CREATE TABLE `vp_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`applied_by` text NOT NULL,
	`applied_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vp_applications_state_check" CHECK("vp_applications"."state" in ('pending', 'approved', 'rejected', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `vp_applications_scope_idx` ON `vp_applications` (`scope_id`,`state`);
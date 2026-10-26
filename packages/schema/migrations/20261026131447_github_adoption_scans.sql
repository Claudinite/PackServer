CREATE TABLE `adoption_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`cursor` text,
	`rate_limit_remaining` integer,
	`truncated` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pack_declarations` (
	`scan_id` text NOT NULL,
	`pack` text NOT NULL,
	`repository` text NOT NULL,
	`owner` text NOT NULL,
	`pinned_version` text,
	`settings_path` text NOT NULL,
	PRIMARY KEY(`scan_id`, `pack`, `repository`),
	FOREIGN KEY (`scan_id`) REFERENCES `adoption_scans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pack_declarations_pack_idx` ON `pack_declarations` (`pack`,`scan_id`);--> statement-breakpoint
CREATE INDEX `pack_declarations_owner_idx` ON `pack_declarations` (`owner`,`scan_id`);
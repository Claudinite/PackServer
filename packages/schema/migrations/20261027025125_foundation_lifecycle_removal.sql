ALTER TABLE `pack_versions` ADD `state_before_removal` text;--> statement-breakpoint
ALTER TABLE `pack_versions` ADD `objects_deleted_at` text;--> statement-breakpoint
ALTER TABLE `pack_versions` ADD `objects_purged_at` text;--> statement-breakpoint
ALTER TABLE `packs` ADD `removed_at` text;
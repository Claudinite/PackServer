ALTER TABLE `validation_runs` ADD `tree_hash` text;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `canonical_sha256` text;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `canonical_key` text;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `committed_at` text;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `source_verified` integer;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `widening` integer;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `score` integer;--> statement-breakpoint
ALTER TABLE `validation_runs` ADD `rules_version` text;
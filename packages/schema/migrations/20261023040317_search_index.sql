CREATE TABLE `pack_search` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pack_id` text NOT NULL,
	`name` text NOT NULL,
	`pitch` text NOT NULL,
	`category` text NOT NULL,
	`tags` text NOT NULL,
	`skills` text NOT NULL,
	`parts` text NOT NULL,
	`has_repository` integer NOT NULL,
	`card` text NOT NULL,
	`demotion` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pack_search_demotion_check" CHECK("pack_search"."demotion" is null or "pack_search"."demotion" in ('advisory', 'failed_validation', 'abuse_hold'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pack_search_pack_unique` ON `pack_search` (`pack_id`);--> statement-breakpoint
CREATE INDEX `pack_search_category_idx` ON `pack_search` (`category`);--> statement-breakpoint
CREATE TABLE `pack_stats` (
	`pack_id` text PRIMARY KEY NOT NULL,
	`fetches_30d` integer DEFAULT 0 NOT NULL,
	`fetches_7d` integer DEFAULT 0 NOT NULL,
	`fetches_prev_28d` integer DEFAULT 0 NOT NULL,
	`stars` integer DEFAULT 0 NOT NULL,
	`stars_7d` integer DEFAULT 0 NOT NULL,
	`stars_prev_28d` integer DEFAULT 0 NOT NULL,
	`rating` real,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recent` (
	`pack_id` text PRIMARY KEY NOT NULL,
	`promoted_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recent_promoted_at_idx` ON `recent` (`promoted_at`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `packs_fts` USING fts5(
	`name`, `pitch`, `tags`, `skills`, `category`,
	content='pack_search', content_rowid='seq',
	tokenize='porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `pack_search_ai` AFTER INSERT ON `pack_search` BEGIN
	INSERT INTO `packs_fts`(`rowid`, `name`, `pitch`, `tags`, `skills`, `category`)
	VALUES (new.`seq`, new.`name`, new.`pitch`, new.`tags`, new.`skills`, new.`category`);
END;
--> statement-breakpoint
CREATE TRIGGER `pack_search_ad` AFTER DELETE ON `pack_search` BEGIN
	INSERT INTO `packs_fts`(`packs_fts`, `rowid`, `name`, `pitch`, `tags`, `skills`, `category`)
	VALUES ('delete', old.`seq`, old.`name`, old.`pitch`, old.`tags`, old.`skills`, old.`category`);
END;
--> statement-breakpoint
CREATE TRIGGER `pack_search_au` AFTER UPDATE ON `pack_search` BEGIN
	INSERT INTO `packs_fts`(`packs_fts`, `rowid`, `name`, `pitch`, `tags`, `skills`, `category`)
	VALUES ('delete', old.`seq`, old.`name`, old.`pitch`, old.`tags`, old.`skills`, old.`category`);
	INSERT INTO `packs_fts`(`rowid`, `name`, `pitch`, `tags`, `skills`, `category`)
	VALUES (new.`seq`, new.`name`, new.`pitch`, new.`tags`, new.`skills`, new.`category`);
END;

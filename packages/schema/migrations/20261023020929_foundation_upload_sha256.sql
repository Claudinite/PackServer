ALTER TABLE `pack_versions` ADD `upload_sha256` text;--> statement-breakpoint
CREATE INDEX `pack_versions_sha256_idx` ON `pack_versions` (`sha256`);--> statement-breakpoint
CREATE INDEX `pack_versions_upload_sha256_idx` ON `pack_versions` (`upload_sha256`);
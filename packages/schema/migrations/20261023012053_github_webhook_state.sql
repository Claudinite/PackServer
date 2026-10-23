CREATE TABLE `github_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_installations` (
	`installation_id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`sender_login` text NOT NULL,
	`repository_selection` text NOT NULL,
	`status` text NOT NULL,
	`installed_at` text NOT NULL,
	`uninstalled_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "github_installations_status_check" CHECK("github_installations"."status" in ('active', 'suspended', 'deleted')),
	CONSTRAINT "github_installations_account_type_check" CHECK("github_installations"."account_type" in ('Organization', 'User')),
	CONSTRAINT "github_installations_selection_check" CHECK("github_installations"."repository_selection" in ('all', 'selected'))
);
--> statement-breakpoint
CREATE INDEX `github_installations_account_idx` ON `github_installations` (`account_id`);--> statement-breakpoint
CREATE TABLE `github_issue_states` (
	`repository_id` integer NOT NULL,
	`issue_number` integer NOT NULL,
	`repository` text NOT NULL,
	`html_url` text NOT NULL,
	`state` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`repository_id`, `issue_number`),
	CONSTRAINT "github_issue_states_state_check" CHECK("github_issue_states"."state" in ('open', 'closed', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX `github_issue_states_url_idx` ON `github_issue_states` (`html_url`);
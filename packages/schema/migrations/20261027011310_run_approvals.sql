CREATE TABLE `run_approvals` (
	`run_id` text PRIMARY KEY NOT NULL,
	`reasons` text NOT NULL,
	`sheet` text NOT NULL,
	`requested_at` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`event_sent_at` text,
	CONSTRAINT "run_approvals_approved_check" CHECK(("run_approvals"."approved_by" is null) = ("run_approvals"."approved_at" is null)),
	CONSTRAINT "run_approvals_reasons_check" CHECK(json_valid("run_approvals"."reasons") and json_valid("run_approvals"."sheet"))
);
--> statement-breakpoint
CREATE INDEX `run_approvals_open_idx` ON `run_approvals` (`approved_at`);
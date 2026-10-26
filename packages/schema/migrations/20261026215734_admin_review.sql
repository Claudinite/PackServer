CREATE TABLE `review_appeals` (
	`run_id` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`submitted_by` text NOT NULL,
	`submitted_at` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`event_sent_at` text,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_appeals_state_check" CHECK("review_appeals"."state" in ('open', 'upheld', 'denied')),
	CONSTRAINT "review_appeals_note_check" CHECK(length("review_appeals"."note") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`decided_by` text NOT NULL,
	`decided_at` text NOT NULL,
	`event_sent_at` text,
	`audited_at` text,
	`notified_at` text,
	CONSTRAINT "review_decisions_decision_check" CHECK("review_decisions"."decision" in ('approve', 'reject', 'quarantine_publisher'))
);

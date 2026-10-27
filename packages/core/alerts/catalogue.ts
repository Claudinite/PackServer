/** Where the router files a ticket: an email to ops carrying a link that opens a pre-filled new issue here. */
export const OPS_REPOSITORY = "Claudinite/packserver-ops";

export const PAGE_IDS = [
  "page.read_path_burn",
  "page.site_down_external",
  "page.hash_mismatch",
  "page.index_signature",
  "page.index_stale",
  "page.index_key_changed",
  "page.signing_key_read",
  "page.audit_pipeline",
  "page.rollback_failed",
  "page.account_change",
  "page.admin_new_location",
  "page.credential_stuffing",
  "page.publish_stalled",
  "page.takedown_overdue",
  "page.monitoring_dead",
  "page.storm",
] as const;
export type PageId = (typeof PAGE_IDS)[number];

export const TICKET_KINDS = [
  "webhooks_failing",
  "oidc_blocked",
  "email_failed",
  "abuse_flood",
  "daily_caps_pressure",
  "audit_backlog",
  "canary_rolled_back",
  "d1_size",
  "model_budget",
  "sandbox_budget",
  "synthetic_failing",
  "component",
  "registry",
  "monitoring",
] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

export interface PageDef {
  id: PageId;
  title: string;
  /** What the system has already done by the time the phone buzzes; fixed text, never filled from an event. */
  done: string;
  /** The one tap on the ops page that answers the page. */
  tap: string;
  runbook: string;
  /** A ticket at once and a page at the next support window. */
  supportHours: boolean;
  /** Trust pages are never routed to the rollout controller and never muted by a deployment. */
  trust: boolean;
}

const page = (id: PageId, runbook: string, title: string, done: string, tap: string, flags: { supportHours?: boolean; trust?: boolean } = {}): PageDef => ({
  id, title, done, tap, runbook, supportHours: flags.supportHours ?? false, trust: flags.trust ?? false,
});

export const PAGES: Readonly<Record<PageId, PageDef>> = {
  "page.read_path_burn": page("page.read_path_burn", "RB-01", "Read path is burning its error budget", "The controller rolls back if a rollout is in progress", "Roll back"),
  "page.site_down_external": page("page.site_down_external", "RB-02", "The witness cannot reach the registry", "The status page is kept honest", "Acknowledge"),
  "page.hash_mismatch": page("page.hash_mismatch", "RB-03", "A served archive did not match its hash", "The version is quarantined where it was named", "Quarantine a version", { trust: true }),
  "page.index_signature": page("page.index_signature", "RB-04", "The signed index fails verification", "Nothing automatic is available to the judge", "Regenerate the index", { trust: true }),
  "page.index_stale": page("page.index_stale", "RB-05", "The served index root is stale", "Nothing automatic is available to the judge", "Regenerate the index", { trust: true }),
  "page.index_key_changed": page("page.index_key_changed", "RB-06", "The index was signed by an unexpected key", "Nothing, a scheduled rotation must not be undone", "Acknowledge", { trust: true }),
  "page.signing_key_read": page("page.signing_key_read", "RB-07", "A signing secret was bound to another Worker", "Nothing, the standby promotion is yours", "Acknowledge", { trust: true }),
  "page.audit_pipeline": page("page.audit_pipeline", "RB-08", "The audit record is broken or backed up", "Nothing is possible automatically", "Acknowledge", { trust: true }),
  "page.rollback_failed": page("page.rollback_failed", "RB-09", "Automatic rollback did not complete", "One retry was attempted", "Roll back"),
  "page.account_change": page("page.account_change", "RB-10", "A Cloudflare account change nobody accounts for", "Nothing, the judge token is read-only", "Acknowledge", { trust: true }),
  "page.admin_new_location": page("page.admin_new_location", "RB-11", "Admin access from a new place or without a login", "Nothing", "Acknowledge", { trust: true }),
  "page.credential_stuffing": page("page.credential_stuffing", "RB-12", "Credential stuffing continues past the locks", "Account locks and the 24 hour source block are in place", "Block a source", { trust: true }),
  "page.publish_stalled": page("page.publish_stalled", "RB-13", "Publishing has stalled", "Queued to wait if a budget is the cause", "Pause new packs", { supportHours: true }),
  "page.takedown_overdue": page("page.takedown_overdue", "RB-14", "A security report was not decided within an hour", "The judge held the version", "Quarantine a version", { supportHours: true }),
  "page.monitoring_dead": page("page.monitoring_dead", "RB-15", "Monitoring has stopped reporting", "Rollouts halt by themselves", "Acknowledge", { supportHours: true }),
  "page.storm": page("page.storm", "RB-00", "Page storm, further pages are tickets this hour", "Capped pages were filed as tickets", "Acknowledge"),
};

export const TICKET_TITLES: Readonly<Record<TicketKind, string>> = {
  webhooks_failing: "GitHub webhooks are failing",
  oidc_blocked: "Trusted publishing is being rejected",
  email_failed: "Email sending is failing",
  abuse_flood: "Publish flood, the new-pack kill switch is on",
  daily_caps_pressure: "Daily caps are under pressure",
  audit_backlog: "The audit queue is backing up",
  canary_rolled_back: "A candidate was rolled back",
  d1_size: "The database is near its size limit",
  model_budget: "Model spend reached its daily budget",
  sandbox_budget: "Sandbox minutes reached the budget",
  synthetic_failing: "Synthetic probes are failing",
  component: "A platform component is unhealthy",
  registry: "The registry is burning budget slowly",
  monitoring: "A monitoring input is failing",
};

export const isPageId = (value: unknown): value is PageId => typeof value === "string" && (PAGE_IDS as readonly string[]).includes(value);

import { openModerationAppeals, type OpenAppeal } from "../moderation/appeals.ts";
import { openAbuseReports, type QueuedAbuse } from "../moderation/queue.ts";
import { applicationQueue } from "./applications.ts";
import type { AdminPorts } from "./ports.ts";
import { openSecurityReports, type QueuedReport } from "./reports.ts";
import { heldVersions, openAppeals, type Appeal, type HeldVersion } from "./review.ts";
import type { PendingApplication } from "../scopes/verified-publisher.ts";

export type QueueItem =
  | ({ kind: "abuse-report" } & QueuedAbuse)
  | ({ kind: "report" } & QueuedReport)
  | ({ kind: "held-version" } & HeldVersion)
  | ({ kind: "appeal" } & Appeal)
  | ({ kind: "moderation-appeal" } & OpenAppeal)
  | ({ kind: "application" } & PendingApplication);

export interface ReviewQueue {
  items: QueueItem[];
}

/**
 * Everything waiting for a human, in the order to read it: prioritised abuse reports, urgent reports, then held versions by
 * the publisher's standing, then open appeals and Verified Publisher applications oldest first, then the remaining reports.
 */
export async function reviewQueue(ports: Pick<AdminPorts, "d1">): Promise<ReviewQueue> {
  const [held, appeals, applications, reports, abuse, actionAppeals] = await Promise.all([
    heldVersions(ports), openAppeals(ports), applicationQueue(ports), openSecurityReports(ports), openAbuseReports(ports.d1), openModerationAppeals(ports.d1),
  ]);
  const tag = <K extends QueueItem["kind"]>(kind: K) => <T extends object>(item: T) => ({ kind, ...item }) as unknown as QueueItem;
  return {
    items: [
      ...abuse.filter((r) => r.priority).map(tag("abuse-report")),
      ...reports.filter((r) => r.priority).map(tag("report")),
      ...held.map(tag("held-version")),
      ...appeals.map(tag("appeal")),
      ...actionAppeals.map(tag("moderation-appeal")),
      ...applications.map(tag("application")),
      ...reports.filter((r) => !r.priority).map(tag("report")),
      ...abuse.filter((r) => !r.priority).map(tag("abuse-report")),
    ],
  };
}

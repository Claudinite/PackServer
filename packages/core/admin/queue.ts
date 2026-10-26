import { applicationQueue } from "./applications.ts";
import type { AdminPorts } from "./ports.ts";
import { openSecurityReports, type QueuedReport } from "./reports.ts";
import { heldVersions, openAppeals, type Appeal, type HeldVersion } from "./review.ts";
import type { PendingApplication } from "../scopes/verified-publisher.ts";

export type QueueItem =
  | ({ kind: "report" } & QueuedReport)
  | ({ kind: "held-version" } & HeldVersion)
  | ({ kind: "appeal" } & Appeal)
  | ({ kind: "application" } & PendingApplication);

export interface ReviewQueue {
  items: QueueItem[];
}

/**
 * Everything waiting for a human, in the order to read it: urgent reports, then held versions by the publisher's standing,
 * then open appeals and Verified Publisher applications oldest first, then the remaining reports.
 */
export async function reviewQueue(ports: Pick<AdminPorts, "d1">): Promise<ReviewQueue> {
  const [held, appeals, applications, reports] = await Promise.all([heldVersions(ports), openAppeals(ports), applicationQueue(ports), openSecurityReports(ports)]);
  const tag = <K extends QueueItem["kind"]>(kind: K) => <T extends object>(item: T) => ({ kind, ...item }) as unknown as QueueItem;
  return {
    items: [
      ...reports.filter((r) => r.priority).map(tag("report")),
      ...held.map(tag("held-version")),
      ...appeals.map(tag("appeal")),
      ...applications.map(tag("application")),
      ...reports.filter((r) => !r.priority).map(tag("report")),
    ],
  };
}

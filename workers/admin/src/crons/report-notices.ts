import { reportPass } from "@packserver/core/reports";
import type { CronJob } from "./index";

/**
 * Reminds owners 7 days before a security report's timer ends, tells registry security when it ends, drops stale
 * pending attachments, then mails everything queued (REQ-MOD-002).
 */
export const reportNotices: CronJob = async ({ ports, config }) => {
  const siteOrigin = config?.siteOrigin;
  if (!siteOrigin) throw new Error("the site origin is not configured");
  const securityAddress = config?.securityAddress;
  if (!securityAddress) throw new Error("the registry security address is not configured");
  const { clock, rng, d1, mail } = ports;
  console.log(JSON.stringify({ at: "cron.report-notices", ...(await reportPass({ clock, rng, d1, siteOrigin }, { mail, siteOrigin, securityAddress })) }));
};

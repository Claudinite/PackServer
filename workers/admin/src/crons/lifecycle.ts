import { drainLifecycleNotices } from "@packserver/core/publishing";
import type { CronJob } from "./index";

/** Mails the digests of yanks and deprecations that stargazers and report authors are owed (REQ-MOD-013). */
export const lifecycle: CronJob = async (runtime) => {
  const { clock, d1, mail } = runtime.ports;
  const siteOrigin = runtime.config?.siteOrigin;
  if (!siteOrigin) throw new Error("the site origin is not configured");
  console.log(JSON.stringify({ at: "cron.lifecycle", ...(await drainLifecycleNotices({ clock, d1 }, { mail, siteOrigin })) }));
};

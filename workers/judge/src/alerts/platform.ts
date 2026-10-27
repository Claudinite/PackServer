export interface QueueBacklog {
  queue: string;
  depth: number;
  /** Null when the queue says nothing about its oldest message, which is not the same as an empty queue. */
  oldestAgeS: number | null;
}

export interface Platform {
  queueBacklogs(nowMs: number): Promise<QueueBacklog[]>;
  /** Logpush jobs whose last attempt failed and was not followed by a success. */
  failingLogpushJobs(): Promise<number>;
}

export interface PlatformConfig {
  accountId: () => Promise<string>;
  zoneId: string;
  token: () => Promise<string>;
  /** Queue name to id. */
  queueIds: Readonly<Record<string, string>>;
}

export const parseQueueIds = (list: string): Record<string, string> =>
  Object.fromEntries(list.split(",").map((pair) => pair.trim().split(":")).filter((p): p is [string, string] => p.length === 2 && p[0] !== "" && p[1] !== ""));

/** Cloudflare's REST API for the realtime queue metrics and the zone's Logpush jobs, with a token that can read them and nothing else. */
export function cloudflarePlatform(config: PlatformConfig, fetchImpl: typeof fetch = fetch): Platform {
  async function get(path: string): Promise<unknown> {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/${path}`, { headers: { authorization: `Bearer ${await config.token()}` } });
    if (!response.ok) throw new Error(`the Cloudflare API answered ${response.status} for ${path.split("/")[0]}`);
    const body = (await response.json()) as { success?: boolean; result?: unknown };
    if (body.success === false) throw new Error(`the Cloudflare API refused ${path.split("/")[0]}`);
    return body.result;
  }
  return {
    async queueBacklogs(now) {
      const account = await config.accountId();
      const out: QueueBacklog[] = [];
      for (const [queue, id] of Object.entries(config.queueIds)) {
        const m = (await get(`accounts/${account}/queues/${id}/metrics`)) as { backlog_count?: unknown; oldest_message_timestamp_ms?: unknown } | null;
        if (typeof m?.backlog_count !== "number") throw new Error(`queue ${queue} reported no backlog`);
        const oldest = typeof m.oldest_message_timestamp_ms === "number" && m.oldest_message_timestamp_ms > 0 ? m.oldest_message_timestamp_ms : null;
        out.push({ queue, depth: m.backlog_count, oldestAgeS: m.backlog_count === 0 ? 0 : oldest === null ? null : Math.max(0, Math.round((now - oldest) / 1000)) });
      }
      return out;
    },
    async failingLogpushJobs() {
      const jobs = await get(`zones/${config.zoneId}/logpush/jobs`);
      if (!Array.isArray(jobs)) throw new Error("the Logpush listing was not a list");
      return jobs.filter((j: { last_error?: string | null; last_complete?: string | null }) => typeof j.last_error === "string" && (typeof j.last_complete !== "string" || j.last_error > j.last_complete)).length;
    },
  };
}

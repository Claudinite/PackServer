export interface QueueBacklog {
  queue: string;
  depth: number;
  /** Null when the queue says nothing about its oldest message, which is not the same as an empty queue. */
  oldestAgeS: number | null;
}

export interface ScriptBinding {
  name: string;
  /** The Secrets Store secret a binding reads, when it is one. */
  secretName: string | null;
}

export interface Platform {
  /** Empty when no queue ids are configured. */
  queueBacklogs(nowMs: number): Promise<QueueBacklog[]>;
  /** Logpush jobs whose last attempt failed and was not followed by a success; null when no zone is configured. */
  failingLogpushJobs(): Promise<number | null>;
  /** The bindings a Worker script carries right now, read back from the account. */
  scriptBindings(script: string): Promise<ScriptBinding[]>;
}

export interface PlatformConfig {
  accountId: () => Promise<string>;
  zoneId: string | undefined;
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
    async scriptBindings(script) {
      const settings = (await get(`accounts/${await config.accountId()}/workers/scripts/${encodeURIComponent(script)}/settings`)) as { bindings?: unknown } | null;
      if (!Array.isArray(settings?.bindings)) throw new Error("the script settings carried no bindings list");
      return settings.bindings.flatMap((b: { name?: unknown; secret_name?: unknown }) =>
        typeof b?.name === "string" ? [{ name: b.name, secretName: typeof b.secret_name === "string" ? b.secret_name : null }] : [],
      );
    },
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
      if (!config.zoneId) return null;
      const jobs = await get(`zones/${config.zoneId}/logpush/jobs`);
      if (!Array.isArray(jobs)) throw new Error("the Logpush listing was not a list");
      return jobs.filter((j: { last_error?: string | null; last_complete?: string | null }) => typeof j.last_error === "string" && (typeof j.last_complete !== "string" || j.last_error > j.last_complete)).length;
    },
  };
}

const SIGNING_KEY = /signing[-_]?key/i;
/** Only the validator may hold a signing secret. */
export const mayHoldSigningKey = (script: string): boolean => /^validator(-staging)?$/.test(script);

/** Whether any binding reads a signing secret, by the binding's name or the secret it points at. */
export const bindsSigningKey = (bindings: readonly ScriptBinding[]): boolean => bindings.some((b) => SIGNING_KEY.test(b.name) || SIGNING_KEY.test(b.secretName ?? ""));

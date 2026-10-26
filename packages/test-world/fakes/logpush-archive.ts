import { network, utcDate } from "@packserver/core/telemetry";

/** The slice of the `ops` bucket the fake writes: what the zone's Logpush jobs deliver to it. */
export interface ArchiveSink {
  put(key: string, body: Uint8Array): Promise<unknown>;
}

export interface FakeDownload {
  /** `@scope/name`, as the request path carries it. */
  pack: string;
  version: string;
  /** The caller's address: the fake keeps only the network the Transformer would, never the address. */
  from: string;
  /** Epoch ms of the request. */
  at: number;
  /** A cache hit is delivered by the sampled job, a miss by the unsampled one. */
  job: "hits" | "misses";
  status?: number;
  path?: string;
}

/**
 * Logpush's delivery to R2 as the Transformer leaves it (D59): one NDJSON object per call, with
 * `ClientNetwork` for the caller and no `ClientIP`. The fake does not sample: a scenario writes
 * the records the sampled job would have delivered.
 */
export class LogpushArchive {
  private objects = 0;
  constructor(private readonly sink: ArchiveSink) {}

  /** Delivers these requests as one object per job, in the folder of the day they are delivered (epoch ms), whenever each request was made. */
  async deliver(requests: readonly FakeDownload[], deliveredAt: number): Promise<number> {
    const grouped = new Map<string, string[]>();
    for (const r of requests) {
      const net = network(r.from);
      if (net === undefined) throw new Error(`not an address: ${r.from}`);
      const record = {
        CacheCacheStatus: r.job === "hits" ? "hit" : "miss",
        CacheResponseStatus: r.status ?? 200,
        ClientCountry: "us",
        ClientNetwork: net,
        ClientRequestHost: "packs.test",
        ClientRequestMethod: "GET",
        ClientRequestPath: r.path ?? `/${r.pack}/${r.version}/pack.tar.zst`,
        ClientRequestUserAgent: "cn/1.0.0",
        EdgeResponseStatus: r.status ?? 200,
        EdgeStartTimestamp: new Date(r.at).toISOString(),
      };
      const folder = `logs/http-requests/${r.job}/${utcDate(deliveredAt).replaceAll("-", "")}/`;
      grouped.set(folder, [...(grouped.get(folder) ?? []), JSON.stringify(record)]);
    }
    for (const [folder, lines] of grouped) {
      await this.sink.put(`${folder}${String(++this.objects).padStart(5, "0")}-${Math.random().toString(36).slice(2, 8)}.log`, new TextEncoder().encode(lines.join("\n") + "\n"));
    }
    return grouped.size;
  }
}

/** What the Analytics Engine read returns for the serving Worker's private `downloads` points. */
export class FakeDownloadPoints {
  private points: Array<{ pack: string; version: string; day: string; principal: string }> = [];
  record(point: { pack: string; version: string; day: string; principal: string }): void {
    this.points.push(point);
  }
  reader = async (sinceDay: string): Promise<Array<{ pack: string; version: string; day: string; principal: string }>> => this.points.filter((p) => p.day >= sinceDay);
}

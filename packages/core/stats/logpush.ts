/** A hit is delivered at one in ten (`infra/zone/logpush.json`), so each stands for ten. */
export const HIT_SAMPLE_SCALE = 10;

export interface LogJob {
  job: "hits" | "misses";
  prefix: string;
  /** How many fetches one record of the job stands for. */
  weight: number;
}

export const LOG_JOBS: readonly LogJob[] = [
  { job: "hits", prefix: "logs/http-requests/hits/", weight: HIT_SAMPLE_SCALE },
  { job: "misses", prefix: "logs/http-requests/misses/", weight: 1 },
];

/** The two `YYYYMMDD` folder names Logpush writes under a job's prefix. */
export const compactDay = (day: string): string => day.replaceAll("-", "");

export interface ArchiveFetch {
  /** `@scope/name`. */
  pack: string;
  version: string;
  /** UTC `YYYY-MM-DD`. */
  day: string;
  /** The `/24` or `/48` the request came from. */
  network: string;
}

export interface ParsedLog {
  fetches: ArchiveFetch[];
  /** Lines that were not a counted download: other paths, failures, unreadable records. */
  skipped: number;
}

const ARCHIVE = /^\/(@[^/]+\/[^/]+)\/([^/]+)\/pack\.tar\.zst$/;
const NETWORK = /^(?:[0-9]+\.[0-9]+\.[0-9]+\.0\/24|[0-9a-f:]+::\/48)$/;

function dayOf(value: unknown): string | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? (value > 1e15 ? value / 1e6 : value > 1e12 ? value : value * 1000) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Reads one job's NDJSON, keeping the successful `GET`s of a pack archive that carry a client network. */
export function parseLog(text: string): ParsedLog {
  const fetches: ArchiveFetch[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const path = typeof record.ClientRequestPath === "string" ? ARCHIVE.exec(decoded(record.ClientRequestPath)) : null;
    const status = Number(record.EdgeResponseStatus);
    const network = typeof record.ClientNetwork === "string" ? record.ClientNetwork.toLowerCase() : undefined;
    const day = dayOf(record.EdgeStartTimestamp);
    const method = record.ClientRequestMethod;
    // A record with no network cannot be told apart from another caller, so it is not counted.
    if (!path || !day || !network || !NETWORK.test(network) || status < 200 || status > 299 || (method !== undefined && method !== "GET")) {
      skipped++;
      continue;
    }
    fetches.push({ pack: path[1] as string, version: path[2] as string, day, network });
  }
  return { fetches, skipped };
}

export async function gunzipIfNeeded(bytes: Uint8Array): Promise<string> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

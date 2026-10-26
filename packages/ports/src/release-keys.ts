import keys from "../release-keys.json" with { type: "json" };

/** The `TELEMETRY_KV` key where the release tooling mirrors which versions are candidates in verification. */
export const CANDIDATE_MIRROR_KEY: string = keys.candidateMirror;

/** How long one Worker isolate keeps its answer to "am I the candidate". */
export const CANDIDATE_ISOLATE_CACHE_MS: number = keys.isolateCacheSeconds * 1000;

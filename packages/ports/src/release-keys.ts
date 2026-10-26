import keys from "../release-keys.json" with { type: "json" };

/** The `TELEMETRY_KV` key where the release tooling mirrors which versions are candidates in verification. */
export const CANDIDATE_MIRROR_KEY: string = keys.candidateMirror;

const HOUR_MS = 3_600_000;

/** The scope kind the server gives the probe's tenant; nothing a client sends can set it. */
export const SYNTHETIC_KIND = "synthetic";
export const PROBE_SCOPE = "probe";
export const PROBE_PACK = "p";
/** The private repository whose scheduled workflow publishes the probe's dry-run version. */
export const PROBE_REPOSITORY_NAME = "packserver-probe";
export const PROBE_WORKFLOW = ".github/workflows/probe-dry-run.yml";
/** The owner's fixtures: ordinary public packs the prober reads, published by Ariel's session or CI. */
export const CANARY_SCOPE = "packserver-canary";

/** REQ-OPS-001: a synthetic version is gone this long after it was admitted, and its name may be used again. */
export const SYNTHETIC_VERSION_TTL_MS = 24 * HOUR_MS;

/** Joins a catalogue query's scope table (as `alias`) to keep the synthetic tenant out of every public listing. */
export const publicScopeOnly = (alias = "s"): string => `${alias}.kind <> '${SYNTHETIC_KIND}'`;

/** A run's own flag, which admission sets from its scope's kind. */
export interface SyntheticRun {
  synthetic: boolean | number;
}
const isSyntheticRun = (run: SyntheticRun): boolean => run.synthetic === true || run.synthetic === 1;

/** REQ-OPS-001: the prose screen is skipped for a synthetic run. */
export const screensProse = (run: SyntheticRun): boolean => !isSyntheticRun(run);
/** REQ-OPS-001: a synthetic run never enters the human queue or its counts, whatever the verdict. */
export const entersHumanQueue = (run: SyntheticRun): boolean => !isSyntheticRun(run);

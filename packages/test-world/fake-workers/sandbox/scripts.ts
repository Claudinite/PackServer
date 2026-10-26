// Shared by the fake containers and the world that scripts them; no Workers runtime import, so both sides can type against it.

/** What a test makes container A do to one upload, keyed by the upload's sha256. */
export interface AScript {
  /** The container dies: the call throws every time. */
  crash?: boolean;
  /** The first `n` calls end `error` (infrastructure), then it runs for real. */
  errorTimes?: number;
  /** The run overruns its 5 minutes. */
  timeout?: boolean;
  /** The canonical archive is reported with a different hash than its bytes have. */
  lieAboutCanonical?: boolean;
}

/** What a test makes container B do to one canonical tree, keyed by its tree hash. */
export interface BScript {
  /** Exit status of the env setup the pack ships, run once. */
  exitCode?: number;
  /** Network attempts the pack's code makes while it runs. */
  egressAttempts?: string[];
  /** `false`: no engine loads the pack; `newest-engine-only`: the lowest engine cannot. */
  loads?: false | "newest-engine-only";
  /** The first `n` calls end in an infrastructure error, then the script answers. */
  errorTimes?: number;
  /** The first `n` calls overrun the 5 minute limit, then the script answers. */
  timeoutTimes?: number;
  /** B finds another tree than the one committed. */
  treeMismatch?: boolean;
  /** Coded checks that do not compile, and declared checks that do not parse. */
  compileFails?: string[];
  declaredFails?: string[];
  crash?: boolean;
}

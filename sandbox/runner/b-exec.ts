import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { B_LIMITS } from "./b-limits.ts";
import { clean } from "./b-report.ts";

export interface PackUser {
  uid: number;
  gid: number;
}

/** What every command that runs pack-influenced content is given besides its own arguments. */
export interface Runtime {
  /** Node module that records and refuses egress from Node processes. */
  preloadUrl?: string;
  /** Shared object that does the same for dynamically linked programs. */
  shimPath?: string;
  /** The unprivileged identity pack content runs as; absent where the runner cannot change identity. */
  user?: PackUser;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The head of stdout and stderr together, cleaned. */
  output: string;
  /** Egress lines the command wrote to its record descriptor, unparsed. */
  egressLines: string[];
}

export interface ExecOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  user?: PackUser;
  /** Hand the command a pipe for egress records (descriptor 3). */
  recordEgress?: boolean;
  /** Called with the process group's id so a supervisor can kill it from outside. */
  onSpawn?: (pgid: number) => void;
}

const EGRESS_BYTES = 64 * 1024;

/**
 * Runs one command of pack-influenced content with exactly the given environment, in its own
 * process group, under a deadline. Output past the cap is read and dropped so a flood cannot
 * grow memory. The group is killed when the command exits or times out, and the pipes are cut
 * shortly after, so a daemon that kept them open cannot hold the step past its cap.
 */
export function exec(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let kept = Buffer.alloc(0);
    let egress = Buffer.alloc(0);
    let timedOut = false;
    let child;
    try {
      child = spawn(options.cmd, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe", ...(options.recordEgress ? (["pipe"] as const) : [])],
        detached: true,
        ...(options.user ? { uid: options.user.uid, gid: options.user.gid } : {}),
      });
    } catch {
      resolve({ exitCode: null, signal: null, timedOut: false, output: "", egressLines: [] });
      return;
    }
    const pgid = child.pid;
    if (pgid !== undefined) options.onSpawn?.(pgid);
    const killGroup = () => {
      if (pgid === undefined) return;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const take = (chunk: Buffer) => {
      if (kept.length < B_LIMITS.outputBytes) kept = Buffer.concat([kept, chunk.subarray(0, B_LIMITS.outputBytes - kept.length)]);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const record = child.stdio[3];
    record?.on("data", (chunk: Buffer) => {
      if (egress.length < EGRESS_BYTES) egress = Buffer.concat([egress, chunk.subarray(0, EGRESS_BYTES - egress.length)]);
    });
    record?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      for (const s of [child.stdout, child.stderr, record]) s?.destroy();
      resolve({ exitCode, signal, timedOut, output: clean(kept.toString("utf8")), egressLines: egress.toString("utf8").split("\n").filter(Boolean) });
    };
    const done = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      killGroup();
      // What the command wrote before it ended is already in the pipes and arrives with their close; a daemon that kept them open is cut off after a moment.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        finish(exitCode, signal);
      };
      const cutoff = setTimeout(settle, 100);
      child.once("close", () => {
        clearTimeout(cutoff);
        settle();
      });
    };
    child.on("error", () => done(null, null));
    child.once("exit", done);
  });
}

/** The only environment pack content ever sees. */
export function scrubbedEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: [dirname(process.execPath), "/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    GOPROXY: "off",
    GOFLAGS: "-mod=readonly",
    GOWORK: "off",
    GOENV: "off",
    GOTOOLCHAIN: "local",
    GOCACHE: `${home}/gocache`,
    GOPATH: `${home}/gopath`,
    CGO_ENABLED: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...extra,
  };
}

/** The scrubbed environment plus the egress recorders, for commands that run pack content. */
export function packEnv(home: string, runtime: Runtime): Record<string, string> {
  return scrubbedEnv(home, {
    B_EGRESS_FD: "3",
    ...(runtime.preloadUrl ? { NODE_OPTIONS: `--import=${runtime.preloadUrl}` } : {}),
    ...(runtime.shimPath ? { LD_PRELOAD: runtime.shimPath } : {}),
  });
}

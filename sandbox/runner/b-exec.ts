import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { B_LIMITS } from "./b-limits.ts";
import { clean } from "./b-report.ts";

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The head of stdout and stderr together, cleaned. */
  output: string;
}

export interface ExecOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Called with the process group's id so a supervisor can kill it from outside. */
  onSpawn?: (pgid: number) => void;
}

/**
 * Runs one command of pack-influenced content with exactly the given environment, in its own
 * process group, under a deadline. Output past the cap is read and dropped so a flood cannot
 * grow memory; the group is killed when the command ends, so nothing outlives its step.
 */
export function exec(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let kept = Buffer.alloc(0);
    let timedOut = false;
    let child;
    try {
      child = spawn(options.cmd, options.args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch {
      resolve({ exitCode: null, signal: null, timedOut: false, output: "" });
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
    const done = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      killGroup();
      resolve({ exitCode, signal, timedOut, output: clean(kept.toString("utf8")) });
    };
    child.on("error", () => done(null, null));
    child.on("close", done);
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
    GOFLAGS: "-mod=mod",
    GOTOOLCHAIN: "local",
    GOCACHE: `${home}/gocache`,
    GOPATH: `${home}/gopath`,
    CGO_ENABLED: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...extra,
  };
}

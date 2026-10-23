import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, readSync, rmSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Directory of stand-ins for the network tools, put first on the search path. */
  stubDir?: string;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The head of stdout and stderr together, cleaned. */
  output: string;
  /** Egress lines the command and everything it started wrote to the record channel, unparsed. */
  egressLines: string[];
}

export interface ExecOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  user?: PackUser;
  /** Give the command a record channel: a named pipe whose path is in B_EGRESS_PIPE, writable but not readable by pack content. */
  recordEgress?: boolean;
  /** Called with the process group's id so a supervisor can kill it from outside. */
  onSpawn?: (pgid: number) => void;
}

const EGRESS_BYTES = 64 * 1024;

/** Reads what has been written to the channel so far; the descriptor is non-blocking. */
function drain(fd: number, into: Buffer[], size: { n: number }): void {
  const chunk = Buffer.alloc(8192);
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, chunk, 0, chunk.length, null);
    } catch {
      return;
    }
    if (n <= 0) return;
    if (size.n < EGRESS_BYTES) {
      into.push(Buffer.from(chunk.subarray(0, Math.min(n, EGRESS_BYTES - size.n))));
      size.n += n;
    }
  }
}

/**
 * Runs one command of pack-influenced content with exactly the given environment, in its own
 * process group, under a deadline. Output past the cap is read and dropped so a flood cannot
 * grow memory. The group is killed when the command exits or times out, and the pipes are cut
 * shortly after, so a daemon that kept them open cannot hold the step past its cap.
 */
export function exec(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let kept = Buffer.alloc(0);
    const egress: Buffer[] = [];
    const egressSize = { n: 0 };
    let timedOut = false;
    let child;
    let channelDir: string | undefined;
    let channelFd = -1;
    const env = { ...options.env };
    try {
      if (options.recordEgress) {
        // The runner owns the pipe and keeps it open for reading; the pack identity may only open it for writing.
        channelDir = mkdtempSync(join(tmpdir(), "b-egress-"));
        chmodSync(channelDir, 0o711);
        const path = join(channelDir, "record");
        execFileSync("mkfifo", [path]);
        chmodSync(path, 0o622);
        channelFd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
        env.B_EGRESS_PIPE = path;
      }
      child = spawn(options.cmd, options.args, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        ...(options.user ? { uid: options.user.uid, gid: options.user.gid } : {}),
      });
    } catch {
      if (channelFd >= 0) closeSync(channelFd);
      if (channelDir) rmSync(channelDir, { recursive: true, force: true });
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
    const poll = channelFd >= 0 ? setInterval(() => drain(channelFd, egress, egressSize), 25) : undefined;
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      for (const s of [child.stdout, child.stderr]) s?.destroy();
      clearInterval(poll);
      if (channelFd >= 0) {
        drain(channelFd, egress, egressSize);
        closeSync(channelFd);
      }
      if (channelDir) rmSync(channelDir, { recursive: true, force: true });
      resolve({ exitCode, signal, timedOut, output: clean(kept.toString("utf8")), egressLines: Buffer.concat(egress).toString("utf8").split("\n").filter(Boolean) });
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
export function scrubbedEnv(home: string, extra: Record<string, string> = {}, stubDir?: string): Record<string, string> {
  return {
    PATH: [...(stubDir ? [stubDir] : []), dirname(process.execPath), "/usr/local/go/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    GOPROXY: "off",
    GOFLAGS: "-mod=readonly -buildvcs=false",
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
  return scrubbedEnv(
    home,
    {
      ...(runtime.preloadUrl ? { NODE_OPTIONS: `--import=${runtime.preloadUrl}` } : {}),
      ...(runtime.shimPath ? { LD_PRELOAD: runtime.shimPath } : {}),
    },
    runtime.stubDir,
  );
}

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { chmod, chown, lchown, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { PackUser } from "./b-exec.ts";

/** Hands a directory tree to the identity pack content runs as. */
export async function giveTo(path: string, user: PackUser | undefined): Promise<void> {
  if (!user) return;
  const walk = async (p: string): Promise<void> => {
    await lchown(p, user.uid, user.gid);
    const s = await lstat(p);
    if (s.isDirectory()) for (const e of await readdir(p)) await walk(join(p, e));
  };
  await walk(path);
}

export async function makeDir(path: string, user: PackUser | undefined): Promise<void> {
  await mkdir(path, { recursive: true });
  await giveTo(path, user);
}

/** Pack content must be able to walk into the work area but never write to the runner's own directories. */
export async function openForTraversal(path: string): Promise<void> {
  await chmod(path, 0o711);
}

export class OutDirError extends Error {}

export interface OutLock {
  /** Writes the report under a temporary name and renames it into place. */
  publish(json: string): Promise<void>;
}

/**
 * Refuses an output directory that holds anything, then locks it to the runner: root-owned and not
 * writable by anyone else, so nothing pack content does can put a file there. It stays that way
 * after the report is in: the report is readable by everyone, the directory is never handed back.
 */
export async function lockOut(outDir: string, user: PackUser | undefined): Promise<OutLock> {
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length) throw new OutDirError("the output directory is not empty");
  if (user) {
    await chown(outDir, 0, 0);
    await chmod(outDir, 0o755);
  }
  return {
    async publish(json) {
      const entries = await readdir(outDir);
      if (entries.length) throw new OutDirError("the output directory changed during the run");
      const temp = join(outDir, `.report.${process.pid}.tmp`);
      // wx creates the file and never follows a link; the rename puts it in place atomically.
      const handle = await open(temp, "wx", 0o644);
      try {
        await handle.writeFile(json);
      } finally {
        await handle.close();
      }
      await rename(temp, join(outDir, "report.json"));
    },
  };
}

/** The pack identity must be an ordinary account other than the runner's own; anything else is no isolation. */
export function validPackUser(uidText: string | undefined, runnerUid: number): PackUser | undefined {
  if (!uidText || !/^\d+$/.test(uidText)) return undefined;
  const uid = Number(uidText);
  if (!Number.isSafeInteger(uid) || uid < 1000 || uid === runnerUid) return undefined;
  return { uid, gid: uid };
}

/** True when the process can never gain privileges through a setuid binary. */
export function hasNoNewPrivs(): boolean {
  try {
    return /^NoNewPrivs:\s+1$/m.test(readFileSync("/proc/self/status", "utf8"));
  } catch {
    return false;
  }
}

function packProcessesLeft(user: PackUser): number {
  let found = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const status = (() => {
      try {
        return readFileSync(`/proc/${entry}/status`, "utf8");
      } catch {
        return "";
      }
    })();
    if (/^State:\s+Z/m.test(status)) continue;
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (uids && [uids[1], uids[2], uids[3], uids[4]].some((u) => Number(u) === user.uid)) found++;
  }
  return found;
}

/**
 * Kills every process of the pack identity and returns false when any is still alive. The kill is
 * issued as the pack identity itself (kill(-1) reaches all of its processes at once, so a process
 * that forks a replacement and exits cannot outrun it) and repeated until a scan finds none.
 */
export function reapPackProcesses(user: PackUser): boolean {
  for (let round = 0; round < 20; round++) {
    spawnSync(process.execPath, ["-e", "try{process.kill(-1,'SIGKILL')}catch{}"], { uid: user.uid, gid: user.gid, stdio: "ignore", timeout: 5000, env: {} });
    if (!packProcessesLeft(user)) return true;
  }
  return false;
}

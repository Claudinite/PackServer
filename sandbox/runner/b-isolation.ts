import { chmod, chown, lchown, lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
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
  /** Writes the report and returns the directory to its owner. */
  publish(json: string): Promise<void>;
}

/**
 * Refuses an output directory that holds anything, then locks it to the runner: root-owned and not
 * writable by anyone else, so nothing pack content does can put a file there. The directory goes
 * back to its owner when the report is in place.
 */
export async function lockOut(outDir: string, user: PackUser | undefined): Promise<OutLock> {
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length) throw new OutDirError("the output directory is not empty");
  const original = await lstat(outDir);
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
      if (user) {
        await chown(join(outDir, "report.json"), original.uid, original.gid);
        await chown(outDir, original.uid, original.gid);
        await chmod(outDir, original.mode & 0o7777);
      }
    },
  };
}

/** Kills every process owned by the pack identity, repeating until a sweep finds none. */
export async function reapPackProcesses(user: PackUser): Promise<void> {
  for (let sweep = 0; sweep < 50; sweep++) {
    let found = 0;
    for (const entry of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(entry)) continue;
      const status = await readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
      const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
      if (/^State:\s+Z/m.test(status)) continue;
      if (!uids || ![uids[1], uids[2], uids[3], uids[4]].some((u) => Number(u) === user.uid)) continue;
      found++;
      try {
        process.kill(Number(entry), "SIGKILL");
      } catch {
        // It ended between the scan and the kill.
      }
    }
    if (!found) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}


import { mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Tree } from "@packserver/core/canonical";
import { B_LIMITS } from "./b-limits.ts";
import { exec, scrubbedEnv } from "./b-exec.ts";
import { clean } from "./b-report.ts";

/**
 * What the runner assumes of a cn release tarball and of the engine's command line. The engine's
 * release workflow has not published either yet, so every assumption lives here, in one place.
 */
export const ENGINE_CONTRACT = {
  /** Executable inside the tarball, tried in order. */
  binary: ["cn", "bin/cn"],
  /** Go source of the check SDK (`claudinite.com/checksdk`), a module with its own go.mod. */
  sdkDir: "checksdk",
  sdkModule: "claudinite.com/checksdk",
  /** `@claudinite/sdk` and the rest of what a task worker imports, resolved from the fixture repository's root. */
  nodeModulesDir: "node_modules",
  /** The folder cn keeps its state and vendored packs in, in the member repository the runner simulates (not in this one). */
  stateDir: ".claudinite",
  /** Loading a pack is `cn check world` in the repository that vendors it; a non-zero exit is a load failure. */
  loadArgs: ["check", "world"],
} as const;

export interface Release {
  /** Directory the tarball was unpacked into. */
  dir: string;
  cn: string;
  sdk: string | null;
  nodeModules: string | null;
}

async function isDir(path: string) {
  return stat(path).then((s) => s.isDirectory(), () => false);
}

async function isFile(path: string) {
  return stat(path).then((s) => s.isFile(), () => false);
}

/** Unpacks an already digest-verified tarball. Entries that could leave the target directory are refused. */
export async function unpackRelease(tgz: string, dir: string, home: string): Promise<Release | null> {
  await mkdir(dir, { recursive: true });
  const env = scrubbedEnv(home);
  const listing = await exec({ cmd: "tar", args: ["-tzf", tgz], cwd: dir, env, timeoutMs: B_LIMITS.stepMs });
  if (listing.exitCode !== 0) return null;
  // The listing is cleaned and capped for display, so it is only a screen for obviously hostile names; GNU tar also refuses `..` and absolute names on extraction.
  if (listing.output.split("\n").some((line) => line.startsWith("/") || line.split("/").includes(".."))) return null;
  const unpacked = await exec({ cmd: "tar", args: ["-xzf", tgz, "-C", dir, "--no-same-owner"], cwd: dir, env, timeoutMs: B_LIMITS.stepMs });
  if (unpacked.exitCode !== 0) return null;
  let cn: string | null = null;
  for (const candidate of ENGINE_CONTRACT.binary) if (!cn && (await isFile(join(dir, candidate)))) cn = join(dir, candidate);
  if (!cn) return null;
  const sdk = join(dir, ENGINE_CONTRACT.sdkDir);
  const modules = join(dir, ENGINE_CONTRACT.nodeModulesDir);
  return { dir, cn, sdk: (await isDir(sdk)) ? sdk : null, nodeModules: (await isDir(modules)) ? modules : null };
}

/** `@acme/gcp` vendors under `<state folder>/shared/packs/acme/gcp/`. */
export const vendorDir = (pack: string) => `${ENGINE_CONTRACT.stateDir}/shared/packs/${pack.slice(1)}`;

async function writeTree(root: string, tree: Tree) {
  for (const d of tree.dirs) await mkdir(join(root, d), { recursive: true });
  for (const f of tree.files) {
    await mkdir(dirname(join(root, f.path)), { recursive: true });
    await writeFile(join(root, f.path), f.content, { mode: f.executable ? 0o755 : 0o644 });
  }
}

/** An empty repository that declares the pack as locally sourced and holds its files where cn vendors them. */
export async function makeFixtureRepo(root: string, pack: string, tree: Tree, home: string, release: Release): Promise<void> {
  await mkdir(join(root, ENGINE_CONTRACT.stateDir), { recursive: true });
  await writeFile(join(root, ENGINE_CONTRACT.stateDir, "settings.yaml"), `packs:\n  declared:\n    - id: ${JSON.stringify(pack)}\n      source: "local"\n`);
  await writeTree(join(root, vendorDir(pack)), tree);
  if (release.nodeModules) {
    await symlink(release.nodeModules, join(root, ENGINE_CONTRACT.nodeModulesDir));
  }
  await exec({ cmd: "git", args: ["init", "-q"], cwd: root, env: scrubbedEnv(home), timeoutMs: B_LIMITS.stepMs });
}

export interface LoadOutcome {
  status: "loaded" | "failed" | "timeout";
  exitCode: number | null;
  file: string | null;
  message: string | null;
}

const LOCATED = /^([A-Za-z0-9._@/-]{1,200}?):(?:\d+:)?(?:\d+:)?\s*(.+)$/;

/** Reads the loader's first located message ("file: message"), relative to the pack. */
export function locate(output: string, pack: string): { file: string | null; message: string | null } {
  const line = output.split("\n").find((l) => l.trim());
  if (!line) return { file: null, message: null };
  const m = LOCATED.exec(line.trim());
  if (!m) return { file: null, message: clean(line) };
  const prefix = `${vendorDir(pack)}/`;
  const file = m[1]!.startsWith(prefix) ? m[1]!.slice(prefix.length) : m[1]!;
  return { file, message: clean(m[2]!) };
}

export async function loadPack(repo: string, release: Release, pack: string, home: string, onSpawn: (pgid: number) => void): Promise<LoadOutcome> {
  const result = await exec({ cmd: release.cn, args: [...ENGINE_CONTRACT.loadArgs], cwd: repo, env: scrubbedEnv(home), timeoutMs: B_LIMITS.stepMs, onSpawn });
  if (result.timedOut) return { status: "timeout", exitCode: null, file: null, message: null };
  if (result.exitCode === 0) return { status: "loaded", exitCode: 0, file: null, message: null };
  return { status: "failed", exitCode: result.exitCode, ...locate(result.output, pack) };
}

import { createHash } from "node:crypto";
import { canonicalise, extractArchive } from "@packserver/core/canonical";
import { listRules } from "@packserver/core/validation";
import { RULES_VERSIONS } from "@packserver/rules";
import type { AScript } from "../fake-workers/sandbox/scripts";
import type { BScript } from "../fake-workers/sandbox/scripts";
import type { Driver } from "../drivers/driver";
import { InfrastructureError } from "./errors";
import { AdmittedVersion, type ArchiveHandle, type Run } from "./publishing";
import { stubModule } from "./errors";
import type { Archive, Version } from "./types";

/** The engine releases the world's mirror holds and pins; fixture archives declare `1.61001.1` as their minimum. */
export const ENGINES = {
  oldest: "1.61001.1",
  versions: ["1.61001.1", "1.61003.0", "1.61004.1"],
  newest: "1.61004.1",
} as const;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const tarballOf = (version: string) => new TextEncoder().encode(`cn ${version}\n`);

/** What a scenario may make container B do to a pack's canonical tree; `exitCode` and `egressAttempts` are the common two. */
export type SandboxScript = BScript;

/** The validation spine: runs, the published rule list, the faked prose screen and the two sandboxes. */
export interface ValidationModule {
  validation: {
    /** Waits for the validator to finish the version's run and returns it. */
    completes(version: Version): Promise<Run>;
    of(version: Version): Promise<Run>;
    /** What `cn pack canonicalise` yields offline for the same tree: the form the registry must commit byte for byte. */
    offlineCanonical(archive: Archive): Promise<{ sha256: string; treeHash: string; bytes: Uint8Array }>;
    /** The archive's files with their modes, to commit the same tree to a repository. */
    sourceFiles(archive: Archive & { bytes: Uint8Array }): Promise<Record<string, { content: Uint8Array; executable: boolean }>>;
  };
  /** An address in prose a pack might link to. */
  link(path: string): string;
  /** Stops the validator taking runs, so a scenario about admission alone leaves its runs queued instead of validating them. */
  pauseValidation(): Promise<void>;
  rules: { list(): Promise<ReadonlyArray<{ id: string; class: "fail" | "hold" | "warn" }>> };
  proseScreen: { script(o: { file?: string; probabilities: Record<string, number> }): void; releaseModel(model: string): void };
  sandbox: {
    /** Scripts container B for the archive's canonical tree. */
    script(archive: Archive, o: SandboxScript): Promise<void>;
    /** Makes container A misbehave for this exact upload; unscripted, it runs the real extraction. */
    scriptA(archive: Archive, o: AScript): Promise<void>;
    /** What reached each container: A by the upload's sha256, B by canonical tree hash and the engine files it was handed. */
    calls(): Promise<{ inspected: string[]; ran: Array<{ tree_hash: string; canonical_sha256: string; engines: string[] }> }>;
  };
}

/** The tree hash container A will commit for an upload, computed the same way the registry does. */
export async function canonicalTreeHash(archive: ArchiveHandle): Promise<string> {
  return canonicalise(await extractArchive(archive.bytes)).treeHash;
}

export function createValidation(driver: Driver) {
  const storage = () => {
    if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver has no storage access`);
    return driver.publishStorage;
  };
  const fakes = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fakes`);
    return driver.fakes;
  };

  let seeded = false;
  /** Fills the engine mirror and pins the newest release, once per scenario; the validator refuses to load a pack without them. */
  async function ensureEngines(): Promise<void> {
    if (seeded) return;
    const { ops, sql } = storage();
    const digests: Record<string, string> = {};
    for (const version of ENGINES.versions) {
      const tgz = tarballOf(version);
      digests[version] = sha256(tgz);
      await ops.put(`cn-releases/${version}.tgz`, tgz);
      await ops.put(`cn-releases/${version}.sha256`, `${digests[version]}  ${version}.tgz\n`);
    }
    await ops.put("cn-releases/manifest.json", JSON.stringify({ oldest: ENGINES.oldest, versions: digests }));
    await sql(
      "insert into feature_flags (key, value, security, updated_at) values ('cn_engine_pin', ?, 0, ?) on conflict (key) do update set value = excluded.value",
      [JSON.stringify({ newest: ENGINES.newest, digests }), new Date().toISOString()],
    );
    seeded = true;
  }

  const runOf = async (version: Version): Promise<Run> => {
    if (!(version instanceof AdmittedVersion)) throw new InfrastructureError("validation needs a version a publish returned");
    return version.run;
  };

  const module: ValidationModule = {
    validation: {
      of: runOf,
      async sourceFiles(archive) {
        const tree = await extractArchive(archive.bytes);
        return Object.fromEntries(tree.files.map((f) => [f.path, { content: f.content, executable: f.executable }]));
      },
      async offlineCanonical(archive) {
        const canonical = canonicalise(await extractArchive((archive as ArchiveHandle).bytes));
        return { sha256: canonical.sha256, treeHash: canonical.treeHash, bytes: canonical.archive };
      },
      completes: async (version) => (await runOf(version)).finished(),
    },
    pauseValidation: async () => {
      await storage().sql("insert into feature_flags (key, value, security, updated_at) values ('validation_dispatch', 'paused', 0, ?) on conflict (key) do update set value = excluded.value", [
        new Date().toISOString(),
      ]);
    },
    link: (path) => `https://example.org/${path}`,
    rules: { list: async () => listRules(RULES_VERSIONS.at(-1)!).map(({ id, class: cls }) => ({ id, class: cls })) },
    proseScreen: stubModule<ValidationModule>("proseScreen").proseScreen,
    sandbox: {
      async script(archive, o) {
        await fakes().scriptSandboxB(await canonicalTreeHash(archive as ArchiveHandle), o);
      },
      async scriptA(archive, o) {
        await fakes().scriptSandboxA((archive as ArchiveHandle).sha256, o);
      },
      async calls() {
        const a = await (fakes().workers.sandboxA ?? (() => { throw new InfrastructureError("sandbox A is not booted"); })()).call<{ inspected: string[] }>("calls");
        const b = await (fakes().workers.sandboxB ?? (() => { throw new InfrastructureError("sandbox B is not booted"); })()).call<{ ran: Array<{ tree_hash: string; canonical_sha256: string; engines: string[] }> }>("calls");
        return { inspected: a.inspected, ran: b.ran };
      },
    },
  };
  return { module, ensureEngines };
}

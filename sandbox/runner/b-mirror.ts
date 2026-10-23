import { z } from "zod";
import { Sha256 } from "@packserver/schema";
import { compareThreePart, isThreePart } from "@packserver/core/validation";

/**
 * The cn release mirror in R2 `ops` as docs/operations/release.md and the engine's release
 * workflow describe it: `cn-releases/<version>.tgz` with a `<version>.sha256` sidecar, and a manifest
 * naming the oldest supported version and every release's digest. The manifest's key and shape
 * are the part the engine has not published yet (see the pull request's decisions).
 */
export const MIRROR_LAYOUT = {
  prefix: "cn-releases",
  manifestKey: "cn-releases/manifest.json",
  tgzKey: (version: string) => `cn-releases/${version}.tgz`,
  sidecarKey: (version: string) => `cn-releases/${version}.sha256`,
} as const;

export const MirrorManifest = z.strictObject({
  oldest: z.string().refine(isThreePart),
  /** Every release in the mirror and its tarball's SHA-256. */
  versions: z.record(z.string().refine(isThreePart), Sha256),
});
export type MirrorManifest = z.infer<typeof MirrorManifest>;

/** Where the mirror is read from: an R2 binding in the Worker, a directory or a URL elsewhere. Null is "no such object". */
export interface MirrorReader {
  get(key: string): Promise<Uint8Array | null>;
}

export class MirrorError extends Error {
  readonly code: "missing" | "digest_mismatch" | "digest_unpinned" | "manifest_invalid" | "version_unknown";

  constructor(code: MirrorError["code"], detail: string) {
    super(`${code}: ${detail}`);
    this.name = "MirrorError";
    this.code = code;
  }
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function httpMirror(baseUrl: string, fetchFn: typeof fetch = fetch): MirrorReader {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  return {
    async get(key) {
      const response = await fetchFn(new URL(key, base));
      if (response.status === 404) return null;
      if (!response.ok) throw new MirrorError("missing", `${key} answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export async function readManifest(mirror: MirrorReader): Promise<MirrorManifest> {
  const bytes = await mirror.get(MIRROR_LAYOUT.manifestKey);
  if (!bytes) throw new MirrorError("missing", MIRROR_LAYOUT.manifestKey);
  try {
    return MirrorManifest.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new MirrorError("manifest_invalid", MIRROR_LAYOUT.manifestKey);
  }
}

/**
 * Fetches one release and returns its bytes only when the tarball hashes to `expectedSha256`, the
 * digest the caller holds from its own pin. The mirror's sidecar and manifest entry must say the
 * same, so a tampered object and a tampered digest file cannot agree by accident.
 */
export async function fetchRelease(mirror: MirrorReader, manifest: MirrorManifest, version: string, expectedSha256: string): Promise<Uint8Array> {
  const listed = manifest.versions[version];
  if (!listed) throw new MirrorError("version_unknown", version);
  if (listed !== expectedSha256) throw new MirrorError("digest_mismatch", `${version}: the manifest lists another digest than the pin`);
  const sidecar = await mirror.get(MIRROR_LAYOUT.sidecarKey(version));
  if (!sidecar) throw new MirrorError("missing", MIRROR_LAYOUT.sidecarKey(version));
  if (new TextDecoder().decode(sidecar).trim().split(/\s+/)[0] !== expectedSha256) throw new MirrorError("digest_mismatch", `${version}: the sidecar lists another digest than the pin`);
  const bytes = await mirror.get(MIRROR_LAYOUT.tgzKey(version));
  if (!bytes) throw new MirrorError("missing", MIRROR_LAYOUT.tgzKey(version));
  if ((await sha256Of(bytes)) !== expectedSha256) throw new MirrorError("digest_mismatch", `${version}: the tarball does not hash to the pin`);
  return bytes;
}

export interface EngineSelection {
  newest: string;
  /** The oldest release the pack's `minEngineVersion` allows; the newest one when nothing in the mirror is that new. */
  lowest: string;
  /** False when `minEngineVersion` is older than the mirror's oldest release: engine.unsupported_min_version. */
  supported: boolean;
}

/** `pinned` is the newest release the registry has pinned; both versions are looked up in the manifest. */
export function selectEngines(manifest: MirrorManifest, pinned: string, minEngineVersion: string): EngineSelection {
  if (!manifest.versions[pinned]) throw new MirrorError("version_unknown", pinned);
  const supported = compareThreePart(minEngineVersion, manifest.oldest) >= 0;
  const candidates = Object.keys(manifest.versions)
    .filter((v) => compareThreePart(v, minEngineVersion) >= 0 && compareThreePart(v, pinned) <= 0)
    .sort(compareThreePart);
  return { newest: pinned, lowest: candidates[0] ?? pinned, supported };
}

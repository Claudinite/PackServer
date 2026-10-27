import {
  IndexVersion,
  KeysDocument,
  PrivateEntry,
  RootIndex,
  ScopeIndex,
  SIGNED_DOCUMENT_TTL_MS,
  Timestamp,
  UnsignedKeysDocument,
  UnsignedPrivateEntry,
  UnsignedRoot,
  UnsignedScopeIndex,
  VersionsDocument,
  type RegistryKey,
  type VersionStatus,
} from "@packserver/schema";
import { sha256Hex, utf8 } from "./bytes";
import { canonicalJson } from "./canonical-json";
import { assertKeySet } from "./keys";
import { signDocument } from "./sign";
import type { Signer } from "./keys";

export const NEWEST_ELIGIBLE_LISTED = 20;
export const STATUS_CHANGE_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What `latest_eligible` may never name. Revoked is held out too: cn would refuse it. */
const NEVER_NEWEST: readonly VersionStatus[] = ["yanked", "quarantined", "removed", "revoked"];
const LISTED_AS_NEWEST: readonly VersionStatus[] = ["active", "deprecated"];

export interface DocumentHead {
  serial: number;
  now: Date;
}

function head({ serial, now }: DocumentHead) {
  return {
    serial,
    generated_at: now.toISOString(),
    expires: new Date(now.getTime() + SIGNED_DOCUMENT_TTL_MS).toISOString(),
  };
}

/** The next serial for a document whose last signed serial is known; the first is 1. */
export const nextSerial = (previous: number | null): number => (previous === null ? 1 : previous + 1);

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The order canonical JSON sorts keys in; locale collation would make the bytes depend on the host. */
export const codeUnitCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byNewest = (a: { version: string }, b: { version: string }) => compareVersions(b.version, a.version);

/** A published version as the builders take it, with when its status last changed. */
export type VersionRecord = IndexVersion & {
  /** When the version's status most recently changed (ISO timestamp); null only for a version that has never changed. */
  status_changed_at: string | null;
};

export interface PackRecord {
  name: string;
  removed?: boolean;
  versions: readonly VersionRecord[];
}

function stripRecord(v: VersionRecord): IndexVersion {
  const entry: Record<string, unknown> = { ...v };
  delete entry.status_changed_at;
  if (v.status === "removed") {
    delete entry.sha256;
    delete entry.size;
  }
  return IndexVersion.parse(entry);
}

function assertUniqueVersions(pack: PackRecord) {
  const seen = new Set<string>();
  for (const v of pack.versions) {
    if (seen.has(v.version)) throw new Error(`${pack.name} lists ${v.version} twice`);
    seen.add(v.version);
    if (v.status !== "active" && v.status_changed_at === null) {
      throw new Error(`${pack.name}@${v.version} is ${v.status} with no status_changed_at`);
    }
    if (v.status_changed_at !== null && !Timestamp.safeParse(v.status_changed_at).success) {
      throw new Error(`${pack.name}@${v.version} has an unparseable status_changed_at`);
    }
  }
}

export function latestEligible(versions: readonly Pick<IndexVersion, "version" | "status">[]): string | null {
  const eligible = versions.filter((v) => !NEVER_NEWEST.includes(v.status)).sort(byNewest);
  return eligible[0]?.version ?? null;
}

/**
 * The versions a scope index carries for one pack: the 20 newest eligible plus every non-active
 * version whose status last changed within the last 180 days, and every revoked version whatever its age, so cn
 * sees a revocation without fetching `versions.json`. The rest live in the pack's `versions.json`.
 */
export function selectListedVersions(pack: PackRecord, now: Date): VersionRecord[] {
  assertUniqueVersions(pack);
  const newest = pack.versions
    .filter((v) => LISTED_AS_NEWEST.includes(v.status))
    .sort(byNewest)
    .slice(0, NEWEST_ELIGIBLE_LISTED);
  const cutoff = now.getTime() - STATUS_CHANGE_WINDOW_DAYS * DAY_MS;
  const recentlyChanged = pack.versions.filter(
    (v) => v.status !== "active" && Date.parse(v.status_changed_at as string) >= cutoff,
  );
  const revoked = pack.versions.filter((v) => v.status === "revoked");
  const listed = new Set([...newest, ...recentlyChanged, ...revoked]);
  return [...listed].sort(byNewest);
}

export function buildScopeIndex(input: DocumentHead & { scope: string; packs: readonly PackRecord[] }) {
  const names = new Set<string>();
  const packs = [...input.packs]
    .sort((a, b) => codeUnitCompare(a.name, b.name))
    .map((pack) => {
      if (names.has(pack.name)) throw new Error(`${pack.name} listed twice`);
      names.add(pack.name);
      if (!pack.name.startsWith(`@${input.scope}/`)) throw new Error(`${pack.name} is not in scope ${input.scope}`);
      const listed = selectListedVersions(pack, input.now);
      return {
        name: pack.name,
        latest_eligible: pack.removed ? null : latestEligible(pack.versions),
        ...(pack.removed ? { status: "removed" as const } : {}),
        versions: listed.map(stripRecord),
      };
    });
  return UnsignedScopeIndex.parse({ kind: "scope", scope: input.scope, ...head(input), packs });
}

/** The pack's full signed history, the target of the scope index's cut-off. */
export function buildVersionsDocument(input: DocumentHead & { pack: PackRecord }) {
  assertUniqueVersions(input.pack);
  return {
    kind: "versions" as const,
    pack: input.pack.name,
    ...head(input),
    versions: [...input.pack.versions].sort(byNewest).map(stripRecord),
  };
}

export function buildRoot(input: DocumentHead & { scopes: readonly { scope: string; sha256: string; serial: number }[] }) {
  const seen = new Set<string>();
  for (const s of input.scopes) {
    if (seen.has(s.scope)) throw new Error(`scope ${s.scope} listed twice`);
    seen.add(s.scope);
  }
  const scopes = [...input.scopes].sort((a, b) => codeUnitCompare(a.scope, b.scope)).map(({ scope, sha256, serial }) => ({ scope, sha256, serial }));
  return UnsignedRoot.parse({ kind: "root", ...head(input), scopes });
}

type PrivateVersion = PrivateEntry["versions"][number];

export function buildPrivateEntry(input: DocumentHead & { pack: string; versions: readonly PrivateVersion[] }) {
  const ids = new Set<string>();
  for (const v of input.versions) {
    if (ids.has(v.version_id)) throw new Error(`version id ${v.version_id} listed twice`);
    ids.add(v.version_id);
  }
  const versions = [...input.versions].sort(byNewest);
  return UnsignedPrivateEntry.parse({ kind: "private", pack: input.pack, ...head(input), versions });
}

export function buildKeysDocument(input: DocumentHead & { keys: readonly RegistryKey[] }) {
  assertKeySet(input.keys);
  return UnsignedKeysDocument.parse({ kind: "keys", ...head(input), keys: input.keys });
}

/** A signed document with the bytes that are published and the hash that names them. */
export interface PublishedDocument<T> {
  doc: T;
  bytes: Uint8Array;
  sha256: string;
}

async function publish<T>(schema: { parse(v: unknown): T }, unsigned: object, signer: Signer): Promise<PublishedDocument<T>> {
  const doc = schema.parse(await signDocument(unsigned, signer));
  const bytes = utf8(canonicalJson(doc));
  return { doc, bytes, sha256: await sha256Hex(bytes) };
}

export const signRoot = (unsigned: ReturnType<typeof buildRoot>, signer: Signer) => publish(RootIndex, unsigned, signer);
export const signPrivateEntry = (unsigned: ReturnType<typeof buildPrivateEntry>, signer: Signer) => publish(PrivateEntry, unsigned, signer);
export const signKeysDocument = (unsigned: ReturnType<typeof buildKeysDocument>, signer: Signer) => publish(KeysDocument, unsigned, signer);
export const signVersionsDocument = (unsigned: ReturnType<typeof buildVersionsDocument>, signer: Signer) =>
  publish(VersionsDocument, unsigned, signer);

/** The scope index plus where it is served: the immutable hashed object and the human alias, same bytes. */
export async function signScopeIndex(unsigned: ReturnType<typeof buildScopeIndex>, signer: Signer) {
  const published = await publish(ScopeIndex, unsigned, signer);
  return {
    ...published,
    objectKey: `index/v1/${unsigned.scope}/${published.sha256}.json`,
    aliasKey: `index/v1/${unsigned.scope}.json`,
  };
}

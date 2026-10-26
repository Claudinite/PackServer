import { buildKeysDocument, signKeysDocument, signPrivateEntry, signRoot, signScopeIndex, type Signer } from "@packserver/core/index";
import { privateEntryKey } from "@packserver/core/access";
import { contentDigest, DOC_KEY, INDEX_HEADERS, KEYS_KEY, ROOT_KEY } from "@packserver/core/validation";
import { syncClock, type D1, type R2 } from "@packserver/ports";
import type { SignAndWriteRootRequest, SignPrivateEntriesRequest, SignScopeIndexRequest } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { loadSigning } from "./keys";

type Parsed<S extends { parse(value: unknown): unknown }> = ReturnType<S["parse"]>;
type Ack = { sha256: string; serial: number; key: string; kid: string };

const publicBucket = (rt: ValidatorRuntime): R2 => {
  const bucket = rt.ports.r2.PACKS_PUBLIC;
  if (!bucket) throw new Error("the PACKS_PUBLIC binding is missing");
  return bucket;
};
const privateBucket = (rt: ValidatorRuntime): R2 => {
  const bucket = rt.ports.r2.PACKS_PRIVATE;
  if (!bucket) throw new Error("the PACKS_PRIVATE binding is missing");
  return bucket;
};

const toOptions = (h: { contentType: string; contentDisposition: string; cacheControl: string }) => ({
  content_type: h.contentType,
  content_disposition: h.contentDisposition,
  cache_control: h.cacheControl,
});

async function lastSerial(d1: D1, docKey: string): Promise<number> {
  const row = (await d1.query(`select serial from signed_documents where doc_key = ?`, [docKey])).rows[0];
  return row ? Number(row.serial) : 0;
}

/** Records what was signed last; a lower serial than the one already recorded never replaces it. */
async function record(d1: D1, docKey: string, written: { serial: number; sha256: string; contentHash: string }, at: string): Promise<void> {
  await d1.query(
    `insert into signed_documents (doc_key, serial, sha256, content_hash, signed_at) values (?, ?, ?, ?, ?)
     on conflict (doc_key) do update set serial = excluded.serial, sha256 = excluded.sha256, content_hash = excluded.content_hash, signed_at = excluded.signed_at
     where excluded.serial >= signed_documents.serial`,
    [docKey, written.serial, written.sha256, written.contentHash, at],
  );
}

const nowOf = async (rt: ValidatorRuntime): Promise<Date> => {
  await syncClock(rt.ports.clock);
  return new Date(rt.ports.clock.now());
};

/**
 * A serial never goes backwards: if the coordinator's count was lost, the validator, which saw
 * every document it signed, continues from its own.
 */
const serialFor = async (d1: D1, docKey: string, asked: number): Promise<number> => Math.max(asked, (await lastSerial(d1, docKey)) + 1);

export async function signAndWriteScopeIndex(rt: ValidatorRuntime, request: Parsed<typeof SignScopeIndexRequest>, signing?: { signer: Signer }): Promise<Ack> {
  const { signer } = signing ?? (await loadSigning(rt));
  const d1 = rt.ports.d1;
  const docKey = DOC_KEY.scope(request.scope);
  const unsigned = { ...request.unsigned, serial: await serialFor(d1, docKey, request.unsigned.serial) };
  const published = await signScopeIndex(unsigned, signer);
  const bucket = publicBucket(rt);
  await bucket.putIfAbsent(published.objectKey, published.bytes, toOptions(INDEX_HEADERS.immutable));
  await bucket.put(published.aliasKey, published.bytes, toOptions(INDEX_HEADERS.live));
  await record(d1, docKey, { serial: unsigned.serial, sha256: published.sha256, contentHash: await contentDigest(published.doc) }, (await nowOf(rt)).toISOString());
  return { sha256: published.sha256, serial: unsigned.serial, key: published.objectKey, kid: signer.kid };
}

/** The pack ids (rows, not names) that key the private entries; a pack that is not in the scope is refused. */
async function privateKeyOf(d1: D1, scope: string, pack: string): Promise<string> {
  const name = pack.slice(pack.indexOf("/") + 1);
  const row = (
    await d1.query(
      `select p.id, p.visibility from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?`,
      [scope, name],
    )
  ).rows[0];
  if (!row) throw new Error(`sign.unknown_pack: ${pack}`);
  if (row.visibility !== "private") throw new Error(`sign.not_private: ${pack}`);
  return privateEntryKey(String(row.id));
}

export async function signAndWritePrivateEntries(
  rt: ValidatorRuntime,
  request: Parsed<typeof SignPrivateEntriesRequest>,
  signing?: { signer: Signer },
): Promise<Array<Ack & { pack: string }>> {
  const { signer } = signing ?? (await loadSigning(rt));
  const d1 = rt.ports.d1;
  const bucket = privateBucket(rt);
  const out: Array<Ack & { pack: string }> = [];
  for (const entry of request.entries) {
    const key = await privateKeyOf(d1, request.scope, entry.pack);
    const docKey = DOC_KEY.private(entry.pack);
    const unsigned = { ...entry, serial: await serialFor(d1, docKey, entry.serial) };
    const published = await signPrivateEntry(unsigned, signer);
    await bucket.put(key, published.bytes, toOptions(INDEX_HEADERS.private));
    await record(d1, docKey, { serial: unsigned.serial, sha256: published.sha256, contentHash: await contentDigest(published.doc) }, (await nowOf(rt)).toISOString());
    out.push({ pack: entry.pack, sha256: published.sha256, serial: unsigned.serial, key, kid: signer.kid });
  }
  return out;
}

/** The root and, beside it, the keys document, so both are renewed on the root's cadence. */
export async function signAndWriteRootDocument(rt: ValidatorRuntime, request: Parsed<typeof SignAndWriteRootRequest>): Promise<Ack> {
  const signing = await loadSigning(rt);
  const d1 = rt.ports.d1;
  const bucket = publicBucket(rt);
  const now = await nowOf(rt);

  const keysSerial = await serialFor(d1, DOC_KEY.keys, 1);
  const keys = await signKeysDocument(buildKeysDocument({ serial: keysSerial, now, keys: signing.keys }), signing.signer);
  await bucket.put(KEYS_KEY, keys.bytes, toOptions(INDEX_HEADERS.live));
  await record(d1, DOC_KEY.keys, { serial: keysSerial, sha256: keys.sha256, contentHash: await contentDigest(keys.doc) }, now.toISOString());

  const serial = await serialFor(d1, DOC_KEY.root, request.unsigned.serial);
  const root = await signRoot({ ...request.unsigned, serial }, signing.signer);
  await bucket.put(ROOT_KEY, root.bytes, toOptions(INDEX_HEADERS.live));
  await record(d1, DOC_KEY.root, { serial, sha256: root.sha256, contentHash: await contentDigest(root.doc) }, now.toISOString());
  return { sha256: root.sha256, serial, key: ROOT_KEY, kid: signing.signer.kid };
}


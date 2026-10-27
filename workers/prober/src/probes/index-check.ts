import { applyRevocations, checkScopeAgainstRoot, verifySigned, type RegistryKey, type VerifyOptions } from "@packserver/core/index";
import { KeysDocument, RootIndex, ScopeIndex } from "@packserver/schema";
import type { KV } from "@packserver/ports";
import { fetchBytes } from "../transport";
import { fail, pass, type Probe, type ProbeContext } from "./types";

export const INDEX_SCENARIO = "update_check.signed_index";

const serialKey = (document: string): string => `prober/serial/${document}`;

async function lastSerial(kv: KV, document: string): Promise<number | undefined> {
  const raw = await kv.get(serialKey(document));
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

class IndexFailure extends Error {}

async function document(ctx: ProbeContext, path: string): Promise<{ bytes: Uint8Array; json: unknown }> {
  const { status, bytes } = await fetchBytes(ctx.fetch, new URL(path, ctx.config.packsOrigin).toString());
  if (status !== 200) throw new IndexFailure(`${path} answered ${status}`);
  try {
    return { bytes, json: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    throw new IndexFailure(`${path} is not JSON`);
  }
}

async function verified<T>(
  verify: (raw: unknown, options: VerifyOptions) => Promise<{ ok: true; doc: T } | { ok: false; code: string; detail: string }>,
  ctx: ProbeContext,
  path: string,
  name: string,
  keys: readonly RegistryKey[],
): Promise<{ doc: T; bytes: Uint8Array }> {
  const { bytes, json } = await document(ctx, path);
  const result = await verify(json, { keys, now: new Date(ctx.clock.now()), lastSerial: await lastSerial(ctx.kv, name) });
  if (!result.ok) throw new IndexFailure(`${path}: ${result.code} (${result.detail})`);
  return { doc: result.doc, bytes };
}

/**
 * What cn does before it believes an index: the keys, the root's signature, expiry and serial, the
 * canary scope's entry in the root and the scope file it names, and the fixture's pinned hash.
 */
export const indexProbe: Probe = async (ctx) => {
  const { canary, trustedKeys } = ctx.config;
  if (trustedKeys === null) return fail("INDEX_TRUSTED_KEYS is not configured, so no index can be verified");
  try {
    const keysDocument = await verified((raw, o) => verifySigned(KeysDocument, raw, o), ctx, "/index/v1/keys.json", "keys", trustedKeys);
    const keys = applyRevocations(trustedKeys, keysDocument.doc);
    const root = await verified((raw, o) => verifySigned(RootIndex, raw, o), ctx, "/index/v1/root.json", "root", keys);

    const entry = root.doc.scopes.find((s) => s.scope === canary.scope);
    if (!entry) throw new IndexFailure(`the root does not list @${canary.scope}`);
    const scopePath = `/index/v1/${canary.scope}/${entry.sha256}.json`;
    const scope = await verified((raw, o) => verifySigned(ScopeIndex, raw, o), ctx, scopePath, `scope:${canary.scope}`, keys);
    const link = await checkScopeAgainstRoot(root.doc, canary.scope, scope.bytes, scope.doc);
    if (!link.ok) throw new IndexFailure(`${scopePath}: ${link.detail}`);

    const version = scope.doc.packs.find((p) => p.name === canary.pack)?.versions.find((v) => v.version === canary.version);
    if (!version) throw new IndexFailure(`${canary.pack}@${canary.version} is not in the scope index`);
    if (version.sha256 !== canary.sha256) throw new IndexFailure(`${canary.pack}@${canary.version} is listed with a hash other than the pinned one`);
    if (version.status !== "active") throw new IndexFailure(`${canary.pack}@${canary.version} is ${version.status}`);

    await Promise.all([
      remember(ctx.kv, "keys", keysDocument.doc.serial),
      remember(ctx.kv, "root", root.doc.serial),
      remember(ctx.kv, `scope:${canary.scope}`, scope.doc.serial),
    ]);
    const staleS = Math.max(0, Math.floor((ctx.clock.now() - Date.parse(root.doc.generated_at)) / 1000));
    return pass(`root serial ${root.doc.serial} verified`, { staleS });
  } catch (error) {
    if (error instanceof IndexFailure) return fail(error.message);
    throw error;
  }
};

async function remember(kv: KV, name: string, serial: number): Promise<void> {
  const before = await lastSerial(kv, name);
  if (before === undefined || serial > before) await kv.put(serialKey(name), String(serial));
}

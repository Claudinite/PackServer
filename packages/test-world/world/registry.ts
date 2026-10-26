import { createHash } from "node:crypto";
import { verifySigned } from "@packserver/core/index";
import { ROOT_KEY, KEYS_KEY } from "@packserver/core/validation";
import { KeysDocument, RootIndex, ScopeIndex } from "@packserver/schema";
import type { Driver, PackBucket } from "../drivers/driver";
import { InfrastructureError } from "./errors";
import { seededRegistryKey } from "./packs";
import type { Pack } from "./types";

export interface SignedIndexes {
  root: { document: RootIndex; verifies: boolean; lifetimeMs: number; listsScope: { sha256: string; serial: number } | undefined };
  scope: { document: ScopeIndex; verifies: boolean; lifetimeMs: number; sha256: string; hashedKey: string; aliasIsTheHashedFile: boolean };
}

const POLL_MS = 250;
const SETTLE_MS = 20_000;

const lifetimeOf = (doc: { generated_at: string; expires: string }): number => Date.parse(doc.expires) - Date.parse(doc.generated_at);
const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;

/** The signed documents the registry serves to cn, read from where the validator wrote them. */
export function createRegistry(driver: Driver) {
  const bucket = (): PackBucket => {
    if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver has no storage access`);
    return driver.publishStorage.packs.public;
  };
  const nowMs = async (): Promise<number> => (driver.fakes ? driver.fakes.clock.call<number>("now") : Date.now());
  const scopeOf = (pack: Pick<Pack, "systemName">): string => pack.systemName.slice(1).split("/")[0]!;

  async function readScope(scope: string) {
    const alias = await bucket().get(`index/v1/${scope}.json`);
    return alias ? { alias, document: parse(alias) as { serial: number } } : null;
  }

  async function until<T>(what: string, read: () => Promise<T | null | undefined | false>): Promise<T> {
    const deadline = Date.now() + SETTLE_MS;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new InfrastructureError(`${what} did not happen within ${SETTLE_MS} ms`);
      await wait(POLL_MS);
    }
  }

  return {
    registry: {
      /**
       * The root and the scope index of the pack's scope, once the root names the scope index as served.
       * The root is signed on a batching alarm, so this waits for it.
       */
      async indexes(pack: Pick<Pack, "systemName">, o: { newerThan?: number } = {}): Promise<SignedIndexes> {
        const scope = scopeOf(pack);
        const key = await seededRegistryKey();
        const now = new Date(await nowMs());
        const settled = await until(`the root naming ${scope}'s index`, async () => {
          const served = await readScope(scope);
          const rootBytes = await bucket().get(ROOT_KEY);
          if (!served || !rootBytes || served.document.serial <= (o.newerThan ?? 0)) return null;
          const root = parse(rootBytes) as RootIndex;
          const listed = root.scopes.find((s) => s.scope === scope);
          return listed && listed.sha256 === hex(served.alias) ? { served, root, rootBytes } : null;
        });
        const sha256 = hex(settled.served.alias);
        const hashedKey = `index/v1/${scope}/${sha256}.json`;
        const hashed = await bucket().get(hashedKey);
        const rootCheck = await verifySigned(RootIndex, settled.root, { keys: [key], now });
        const scopeCheck = await verifySigned(ScopeIndex, settled.served.document, { keys: [key], now });
        return {
          root: { document: settled.root, verifies: rootCheck.ok, lifetimeMs: lifetimeOf(settled.root), listsScope: settled.root.scopes.find((s) => s.scope === scope) },
          scope: {
            document: settled.served.document as unknown as ScopeIndex,
            verifies: scopeCheck.ok,
            lifetimeMs: lifetimeOf(settled.served.document as unknown as ScopeIndex),
            sha256,
            hashedKey,
            aliasIsTheHashedFile: hashed !== null && hex(hashed) === sha256,
          },
        };
      },
      /** `keys.json`, checked against the registry's key. */
      async keys(): Promise<{ document: KeysDocument; verifies: boolean }> {
        const bytes = await until("keys.json being written", () => bucket().get(KEYS_KEY));
        const document = parse(bytes);
        const check = await verifySigned(KeysDocument, document, { keys: [await seededRegistryKey()], now: new Date(await nowMs()) });
        return { document: document as KeysDocument, verifies: check.ok };
      },
      /** The scope's serial now; a later read can ask for something newer. */
      async serial(pack: Pick<Pack, "systemName">): Promise<number> {
        return (await readScope(scopeOf(pack)))?.document.serial ?? 0;
      },
      /** Tells the registry the scope's proof changed, as the Worker that noticed would, and waits for the re-signed index. */
      async proofChanged(pack: Pick<Pack, "systemName">, change = "verified_publisher_changed"): Promise<SignedIndexes> {
        const before = await this.serial(pack);
        if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver has no storage access`);
        await driver.publishStorage.reindex.send({ schema: 1, type: "scope.proof_changed", scope: scopeOf(pack), change });
        return this.indexes(pack, { newerThan: before });
      },
    },
  };
}

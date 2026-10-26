import { DO_RPC_SCHEMA_VERSION, type ScopeCoordinatorRpc } from "@packserver/schema";
import type { D1 } from "@packserver/ports";
import type { DoStorage } from "../do-storage";

/** Index rebuilds requested closer together than this are answered by the one just made. */
export const REBUILD_DEBOUNCE_MS = 5_000;

interface Lock {
  run_id: string;
  expires_at: number;
}
interface Rebuilt {
  at: number;
  sha256: string;
  serial: number;
}

/** Writes a scope's content-addressed index through the validator, which alone signs, and returns what was written. */
export interface IndexRebuilder {
  rebuild(scope: string): Promise<{ sha256: string; serial: number }>;
}
/** Tells the root coordinator a scope has a new index. */
export interface RootNotifier {
  scopeChanged(change: { scope: string; sha256: string; serial: number }): Promise<void>;
}

/** The names of the Durable Object that serialises one scope's publishes. */
export const scopeCoordinatorName = (scope: string): string => scope;

/**
 * One scope's publish lock, the promotion commit and the debounce of its index rebuilds, all in
 * storage rather than memory so a reassignment during a deploy drops nothing. The coordinator
 * orchestrates; it never holds a signing key.
 */
export class ScopeCoordinatorLogic implements ScopeCoordinatorRpc {
  constructor(
    private readonly storage: DoStorage,
    private readonly now: () => number,
    private readonly deps: { d1: D1; indexes: IndexRebuilder; root: RootNotifier },
  ) {}

  async ping() {
    return { schema_version: DO_RPC_SCHEMA_VERSION, ok: true as const };
  }

  async acquireLock(request: Parameters<ScopeCoordinatorRpc["acquireLock"]>[0]) {
    const now = this.now();
    const held = await this.storage.get<Lock>("lock");
    if (held && held.expires_at > now && held.run_id !== request.run_id) {
      return { schema_version: DO_RPC_SCHEMA_VERSION, acquired: false, holder_run_id: held.run_id };
    }
    await this.storage.put("lock", { run_id: request.run_id, expires_at: now + request.ttl_s * 1000 } satisfies Lock);
    return { schema_version: DO_RPC_SCHEMA_VERSION, acquired: true, holder_run_id: request.run_id };
  }

  async releaseLock(request: Parameters<ScopeCoordinatorRpc["releaseLock"]>[0]) {
    const held = await this.storage.get<Lock>("lock");
    if (held?.run_id !== request.run_id) return { schema_version: DO_RPC_SCHEMA_VERSION, released: false };
    await this.storage.delete("lock");
    return { schema_version: DO_RPC_SCHEMA_VERSION, released: true };
  }

  /** Promotion's commit point: one batch that moves an approved version to active, and only an approved one. */
  async insertVersion(request: Parameters<ScopeCoordinatorRpc["insertVersion"]>[0]) {
    const [scopeName, packName] = request.pack.slice(1).split("/") as [string, string];
    const { rows } = await this.deps.d1.query(
      `select v.id, v.state from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
       where s.name = ? and p.name = ? and v.version = ?`,
      [scopeName, packName, request.version],
    );
    const version = rows[0] as { id: string; state: string } | undefined;
    const answer = (promoted: boolean, already_promoted: boolean) => ({ schema_version: DO_RPC_SCHEMA_VERSION, promoted, already_promoted });
    if (!version) return answer(false, false);
    if (version.state === "approved") {
      const at = new Date(this.now()).toISOString();
      const [flipped] = await this.deps.d1.batch([
        { sql: `update pack_versions set state = 'active', published_at = ? where id = ? and state = 'approved'`, params: [at, version.id] },
      ]);
      if (flipped?.meta.changes === 1) return answer(true, false);
    }
    const settled = (await this.deps.d1.query(`select state from pack_versions where id = ?`, [version.id])).rows[0] as { state: string } | undefined;
    return answer(false, settled !== undefined && settled.state !== "approved" && settled.state !== "pending");
  }

  /** A request inside the debounce window is answered with the last index and rebuilt by the alarm, so a change is never skipped, only delayed. */
  async rebuildIndex(request: Parameters<ScopeCoordinatorRpc["rebuildIndex"]>[0]) {
    const now = this.now();
    const last = await this.storage.get<Rebuilt>("rebuilt");
    if (last && now - last.at < REBUILD_DEBOUNCE_MS) {
      await this.storage.put("pending", request.scope);
      if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(last.at + REBUILD_DEBOUNCE_MS);
      return { schema_version: DO_RPC_SCHEMA_VERSION, sha256: last.sha256, serial: last.serial };
    }
    return { schema_version: DO_RPC_SCHEMA_VERSION, ...(await this.rebuild(request.scope, now)) };
  }

  /** Runs the rebuild a debounced request is waiting for. */
  async alarm(): Promise<void> {
    const scope = await this.storage.get<string>("pending");
    if (scope === undefined) return;
    await this.rebuild(scope, this.now());
  }

  private async rebuild(scope: string, now: number): Promise<{ sha256: string; serial: number }> {
    const written = await this.deps.indexes.rebuild(scope);
    await this.storage.put("rebuilt", { at: now, ...written } satisfies Rebuilt);
    await this.storage.delete("pending");
    await this.deps.root.scopeChanged({ scope, ...written });
    return written;
  }
}

import { publicScopeOnly } from "@packserver/core/synthetic";
import { DO_RPC_SCHEMA_VERSION, type ScopeCoordinatorRpc } from "@packserver/schema";
import type { D1 } from "@packserver/ports";
import type { DoStorage } from "../do-storage";

/** The production window: index rebuilds requested closer together than this are answered by the one just made. */
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
    private readonly debounceMs: number = REBUILD_DEBOUNCE_MS,
  ) {}

  /** The rebuild in flight, if any, and the scope a request that arrived meanwhile wants rebuilt once more. */
  private running: Promise<{ sha256: string; serial: number }> | null = null;
  private again: string | undefined;

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
    if (this.running) return { schema_version: DO_RPC_SCHEMA_VERSION, ...(await this.rebuild(request.scope)) };
    const now = this.now();
    const last = await this.storage.get<Rebuilt>("rebuilt");
    if (last && now - last.at < this.debounceMs) {
      await this.storage.put("pending", request.scope);
      if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(last.at + this.debounceMs);
      return { schema_version: DO_RPC_SCHEMA_VERSION, sha256: last.sha256, serial: last.serial };
    }
    return { schema_version: DO_RPC_SCHEMA_VERSION, ...(await this.rebuild(request.scope)) };
  }

  /** Runs the rebuild a debounced request is waiting for. */
  async alarm(): Promise<void> {
    const scope = await this.storage.get<string>("pending");
    if (scope === undefined) return;
    await this.rebuild(scope);
  }

  /** The synthetic tenant keeps its own signed index but stays out of the root's list of scopes. */
  private async isPublic(scope: string): Promise<boolean> {
    return (await this.deps.d1.query(`select 1 from scopes s where s.name = ? and ${publicScopeOnly("s")}`, [scope])).rows.length > 0;
  }

  /**
   * One rebuild at a time: a request that arrives while one runs asks for exactly one more
   * after it, and is answered with that one's result, so the newest change is always signed last.
   */
  private rebuild(scope: string): Promise<{ sha256: string; serial: number }> {
    if (this.running) {
      this.again = scope;
      return this.running;
    }
    const run = (async () => {
      let next: string | undefined = scope;
      let written!: { sha256: string; serial: number };
      try {
        while (next !== undefined) {
          this.again = undefined;
          written = await this.deps.indexes.rebuild(next);
          await this.storage.put("rebuilt", { at: this.now(), ...written } satisfies Rebuilt);
          await this.storage.delete("pending");
          if (await this.isPublic(next)) await this.deps.root.scopeChanged({ scope: next, ...written });
          next = this.again;
        }
      } finally {
        this.running = null;
      }
      return written;
    })();
    this.running = run;
    return run;
  }
}

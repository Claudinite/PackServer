import { buildRoot } from "@packserver/core/index";
import { DO_RPC_SCHEMA_VERSION, type RootCoordinatorRpc } from "@packserver/schema";
import type { DoStorage } from "../do-storage";

/** The production window: scope changes arriving within it go out in one signed root. */
export const ROOT_BATCH_MS = 10_000;
/** The root is re-signed at least this often, whether or not a scope changed, so its `expires` never lapses. */
export const ROOT_DAILY_MS = 24 * 3_600_000;
/** After a failed signing the alarm comes back after this long, doubling to the cap. */
export const ROOT_RETRY_MS = 10_000;
export const ROOT_RETRY_CAP_MS = 5 * 60_000;

/** Has the validator sign the root and write it, and says which serial and hash it wrote. */
export interface RootSigner {
  signAndWriteRoot(request: { unsigned: ReturnType<typeof buildRoot> }): Promise<{ sha256: string; serial: number }>;
}

interface ScopeEntry {
  sha256: string;
  serial: number;
}
interface Failure {
  attempts: number;
  message: string;
}

export const ROOT_COORDINATOR_NAME = "root";

/**
 * The one writer of `index/v1/root.json`. It keeps every scope's current hash and serial in
 * storage, batches changes into a signed root on a short alarm and re-signs daily; the validator
 * holds the key and does the signing and the write.
 */
export class RootCoordinatorLogic implements RootCoordinatorRpc {
  constructor(
    private readonly storage: DoStorage,
    private readonly now: () => number,
    private readonly signer: RootSigner,
    private readonly batchMs: number = ROOT_BATCH_MS,
  ) {}

  async ping() {
    return { schema_version: DO_RPC_SCHEMA_VERSION, ok: true as const };
  }

  async notifyScopeChange(request: Parameters<RootCoordinatorRpc["notifyScopeChange"]>[0]) {
    const scopes = (await this.storage.get<Record<string, ScopeEntry>>("scopes")) ?? {};
    const known = scopes[request.scope];
    if (known && known.serial >= request.serial) return { schema_version: DO_RPC_SCHEMA_VERSION, queued: false };
    scopes[request.scope] = { sha256: request.sha256, serial: request.serial };
    await this.storage.put("scopes", scopes);
    await this.storage.put("dirty", true);
    await this.arm(this.now() + this.batchMs);
    return { schema_version: DO_RPC_SCHEMA_VERSION, queued: true };
  }

  /** The earliest wanted alarm wins; a later request never postpones one already set. */
  private async arm(at: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || at < current) await this.storage.setAlarm(at);
  }

  /** Signs the root when scopes changed or the day is up; a failure keeps the work and tries again later. */
  async alarm(): Promise<void> {
    const now = this.now();
    const dirty = (await this.storage.get<boolean>("dirty")) ?? false;
    const dailyDue = await this.storage.get<number>("daily_due");
    const due = dailyDue !== undefined && now >= dailyDue;
    if (!dirty && !due) {
      if (dailyDue !== undefined) await this.arm(dailyDue);
      return;
    }
    const scopes = (await this.storage.get<Record<string, ScopeEntry>>("scopes")) ?? {};
    const serial = ((await this.storage.get<number>("root_serial")) ?? 0) + 1;
    const unsigned = buildRoot({ serial, now: new Date(now), scopes: Object.entries(scopes).map(([scope, e]) => ({ scope, ...e })) });
    try {
      const written = await this.signer.signAndWriteRoot({ unsigned });
      await this.storage.put("root_serial", written.serial);
      await this.storage.put("dirty", false);
      await this.storage.delete("failure");
    } catch (error) {
      const previous = await this.storage.get<Failure>("failure");
      const attempts = (previous?.attempts ?? 0) + 1;
      await this.storage.put("failure", { attempts, message: error instanceof Error ? error.message : String(error) } satisfies Failure);
      await this.storage.setAlarm(now + Math.min(ROOT_RETRY_CAP_MS, ROOT_RETRY_MS * 2 ** (attempts - 1)));
      return;
    }
    const nextDaily = now + ROOT_DAILY_MS;
    await this.storage.put("daily_due", nextDaily);
    await this.storage.setAlarm(nextDaily);
  }

  /** What the last signing attempt left behind, for the self-test and the operator. */
  async status() {
    return {
      schema_version: DO_RPC_SCHEMA_VERSION,
      root_serial: (await this.storage.get<number>("root_serial")) ?? 0,
      dirty: (await this.storage.get<boolean>("dirty")) ?? false,
      failure: (await this.storage.get<Failure>("failure")) ?? null,
    };
  }
}

import { DurableObject } from "cloudflare:workers";
import type { QuotaRpc, RootCoordinatorRpc, ScopeCoordinatorRpc } from "@packserver/schema";
import { createCoordinatorDeps, type ObjectEnv } from "./bindings";
import { ScopeCoordinatorLogic } from "./coordinator";
import type { DoStorage } from "./do-storage";
import { QuotaCounter } from "./quota";
import { RootCoordinatorLogic } from "./root-coordinator";

const storageOf = (ctx: DurableObjectState): DoStorage => ctx.storage;

type Args<T extends (...a: never[]) => unknown> = Parameters<T>;

/** One per scope. Methods are on the prototype because only those are reachable over RPC. */
export class ScopeCoordinator extends DurableObject<ObjectEnv> {
  private readonly logic = new ScopeCoordinatorLogic(storageOf(this.ctx), Date.now, createCoordinatorDeps(this.env));
  ping() {
    return this.logic.ping();
  }
  acquireLock(...args: Args<ScopeCoordinatorRpc["acquireLock"]>) {
    return this.logic.acquireLock(...args);
  }
  releaseLock(...args: Args<ScopeCoordinatorRpc["releaseLock"]>) {
    return this.logic.releaseLock(...args);
  }
  insertVersion(...args: Args<ScopeCoordinatorRpc["insertVersion"]>) {
    return this.logic.insertVersion(...args);
  }
  rebuildIndex(...args: Args<ScopeCoordinatorRpc["rebuildIndex"]>) {
    return this.logic.rebuildIndex(...args);
  }
  override alarm() {
    return this.logic.alarm();
  }
}

/** One per `(kind, principal, day)`. */
export class Quota extends DurableObject<ObjectEnv> {
  private readonly logic = new QuotaCounter(storageOf(this.ctx), Date.now);
  ping() {
    return this.logic.ping();
  }
  consume(...args: Args<QuotaRpc["consume"]>) {
    return this.logic.consume(...args);
  }
  peek(...args: Args<QuotaRpc["peek"]>) {
    return this.logic.peek(...args);
  }
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** The singleton that signs `index/v1/root.json` through the validator. */
export class RootCoordinator extends DurableObject<ObjectEnv> {
  private readonly logic = new RootCoordinatorLogic(storageOf(this.ctx), Date.now, createCoordinatorDeps(this.env).signer);
  ping() {
    return this.logic.ping();
  }
  notifyScopeChange(...args: Args<RootCoordinatorRpc["notifyScopeChange"]>) {
    return this.logic.notifyScopeChange(...args);
  }
  status() {
    return this.logic.status();
  }
  override alarm() {
    return this.logic.alarm();
  }
}

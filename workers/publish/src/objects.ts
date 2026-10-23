import { DurableObject } from "cloudflare:workers";
import { DO_RPC_SCHEMA_VERSION } from "@packserver/schema";

export class ScopeCoordinator extends DurableObject {
  ping() {
    return { schema_version: DO_RPC_SCHEMA_VERSION, ok: true as const };
  }
}

export class Quota extends DurableObject {
  ping() {
    return { schema_version: DO_RPC_SCHEMA_VERSION, ok: true as const };
  }
}

export class RootCoordinator extends DurableObject {
  ping() {
    return { schema_version: DO_RPC_SCHEMA_VERSION, ok: true as const };
  }
}

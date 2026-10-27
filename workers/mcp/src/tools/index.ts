import type { McpServer } from "@modelcontextprotocol/server";
import type { McpRuntime } from "../bindings";
import type { Caller } from "../limits";
import { registerDiscovery } from "./discover";
import { registerDownload } from "./download";
import type { PackExtras } from "./extras";
import { registerPack } from "./pack";

export { unwiredExtras, type Advisory, type PackExtras, type PackRef } from "./extras";
export { UNTRUSTED_NOTICE } from "./result";

/** The tools every caller may use; a credential that can read private packs sees them in the answers. */
export function registerPublicTools(server: McpServer, runtime: McpRuntime, extras: PackExtras, caller: Caller): void {
  registerDiscovery(server, runtime, caller);
  registerPack(server, runtime, extras, caller);
  registerDownload(server, runtime, caller);
}

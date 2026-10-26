import type { McpServer } from "@modelcontextprotocol/server";
import type { McpRuntime } from "../bindings";
import { registerDiscovery } from "./discover";
import { registerDownload } from "./download";
import type { PackExtras } from "./extras";
import { registerPack } from "./pack";

export { unwiredExtras, type Advisory, type PackExtras, type PackRef } from "./extras";
export { UNTRUSTED_NOTICE } from "./result";

/** The tools every caller may use, public packs only. */
export function registerPublicTools(server: McpServer, runtime: McpRuntime, extras: PackExtras): void {
  registerDiscovery(server, runtime);
  registerPack(server, runtime, extras);
  registerDownload(server, runtime);
}

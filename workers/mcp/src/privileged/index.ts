import type { McpServer } from "@modelcontextprotocol/server";
import type { McpRuntime } from "../bindings";
import type { Caller } from "../limits";
import { registerListMyPacks } from "./list-my-packs";
import { registerStarPack } from "./star-pack";

export { accessCallerOf, isPrivilegedTool, mayCall, PRIVILEGED_TOOLS, type PrivilegedTool } from "./access";
export { privatePackView, privateDownload } from "./private-pack";

/** Registered only for a caller whose credential allows them: an unregistered tool does not exist for that request. */
export function registerPrivilegedTools(server: McpServer, runtime: McpRuntime, caller: Caller): void {
  registerListMyPacks(server, runtime, caller);
  registerStarPack(server, runtime, caller);
}

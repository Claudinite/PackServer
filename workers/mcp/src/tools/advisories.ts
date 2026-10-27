import { advisoriesFor } from "@packserver/core/reports";
import type { McpRuntime } from "../bindings";
import type { Advisory, PackRef } from "./extras";

/** One entry per affected version, so a reader can match the version it is looking at. */
export async function publishedAdvisories(runtime: McpRuntime, pack: PackRef): Promise<Advisory[]> {
  const advisories = await advisoriesFor(runtime.ports.d1, pack.id);
  return advisories.flatMap((a) => a.affected_versions.map((version) => ({ version, severity: a.severity, id: a.id, summary: a.summary })));
}

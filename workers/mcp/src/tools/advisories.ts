import { advisoriesFor } from "@packserver/core/reports";
import type { McpRuntime } from "../bindings";
import type { Advisory, PackRef } from "./extras";

/** The advisories naming `version`, one entry per affected version. */
export async function publishedAdvisories(runtime: McpRuntime, pack: PackRef, version: string): Promise<Advisory[]> {
  const advisories = await advisoriesFor(runtime.ports.d1, pack.id, version);
  return advisories.flatMap((a) => a.affected_versions.map((affected) => ({ version: affected, severity: a.severity, id: a.id, summary: a.summary })));
}

import { publishWorkflowTemplate } from "@packserver/publish-action/template";
import type { WebConfig } from "../../bindings";
import type { Registration } from "./data";

export type Yaml = { kind: "yaml"; text: string } | { kind: "unavailable"; why: string };

/** The workflow a registration expects, with the environment's pins; the template refuses values it cannot quote safely. */
export function workflowFor(scope: string, pack: string, r: Registration, pins: WebConfig["workflowPins"]): Yaml {
  if (!r.events.includes("push")) return { kind: "unavailable", why: "The workflow publishes on a pushed tag, and this registration does not allow the push event." };
  if (!r.refs.includes(`refs/tags/${pack}/*`)) return { kind: "unavailable", why: `The workflow publishes on tags ${pack}/*, and this registration does not allow refs/tags/${pack}/*.` };
  if (!pins) return { kind: "unavailable", why: "This environment has no published Action release to pin yet." };
  try {
    const text = publishWorkflowTemplate({
      pack: `@${scope}/${pack}`,
      path: r.path,
      actionSha: pins.actionSha,
      cnVersion: pins.cnVersion,
      cnSha256: pins.cnSha256,
      ...(r.environment === null ? {} : { environment: r.environment }),
    });
    return { kind: "yaml", text };
  } catch (error) {
    return { kind: "unavailable", why: error instanceof Error ? error.message : "The registration cannot be turned into a workflow." };
  }
}

import { findPublicPack, star } from "@packserver/core/community";
import { PackName } from "@packserver/schema";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpRuntime } from "../bindings";
import type { Caller } from "../limits";
import { answer, describe, failure, unavailable } from "../tools/result";
import { mayCall } from "./access";

export function registerStarPack(server: McpServer, runtime: McpRuntime, caller: Caller): void {
  if (caller.kind !== "oauth" || !mayCall(caller, "star_pack")) return;
  const userId = caller.grant.userId;
  server.registerTool(
    "star_pack",
    {
      description: describe("Star a public pack for the person who approved this connection. Starring again changes nothing. There is no tool to unstar: the person does that on the pack's page."),
      inputSchema: z.object({ name: z.string().min(1).describe("Exact pack name, e.g. '@acme/gcp'") }),
    },
    async ({ name }) => {
      try {
        if (!PackName.safeParse(name).success) return failure("not_found", "No public pack has that name.");
        const [scope, packName] = name.slice(1).split("/") as [string, string];
        const ports = { d1: runtime.ports.d1, rng: runtime.ports.rng, clock: runtime.tokenClock };
        const pack = await findPublicPack(ports.d1, scope, packName);
        if (!pack) return failure("not_found", "No public pack has that name.");
        const change = await star(ports, pack, userId);
        return answer({ id: pack.name, starred: true, stars: change.count });
      } catch (error) {
        console.error(`star_pack failed: ${error instanceof Error ? error.message : String(error)}`);
        return unavailable();
      }
    },
  );
}

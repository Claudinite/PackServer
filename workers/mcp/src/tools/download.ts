import { recordAuthenticatedDownload } from "@packserver/core/community";
import { lookupVersion, objectKey, summarise } from "@packserver/core/catalog";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpRuntime } from "../bindings";
import { findPublicPack } from "./catalog";
import type { Caller } from "../limits";
import { accessCallerOf, privateDownload } from "../privileged";
import { answer, describe, failure, unavailable } from "./result";

export function registerDownload(server: McpServer, runtime: McpRuntime, caller: Caller): void {
  const access = accessCallerOf(caller);
  const origin = runtime.config.cdnOrigin.replace(/\/$/, "");
  server.registerTool(
    "get_download",
    {
      description: describe(
        "Get where to download one version of a public pack: the archive URL, its sha256 and the attestation URL. A yanked version resolves only when you name it exactly; a quarantined version answers under_review and no URL. Nothing is fetched into your session by this call.",
      ),
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact pack name, e.g. '@acme/gcp'"),
        version: z.string().optional().describe("An exact version; the newest eligible one by default"),
      }),
    },
    async ({ name, version }) => {
      try {
        const found = await findPublicPack(runtime, name);
        if (found.kind === "missing") return access ? await privateDownload(runtime, caller, access, name, version) : failure("not_found", "No public pack has that name.");
        if (found.kind === "unavailable") return unavailable();
        const { pack } = found;
        if (pack.listing.status === "removed") return failure("removed", "That pack has been removed.");

        const target = version ?? pack.listing.latest_eligible;
        if (target === null) return failure("not_resolved", "No version of that pack is eligible. Name an exact version to resolve a yanked one.");
        const lookup = lookupVersion(pack.rows, target);
        if (lookup.kind === "missing") return failure("not_found", "That pack has no such version.");
        if (lookup.kind === "removed") return failure("removed", "That version has been removed.");

        const summary = summarise(lookup.row, pack.notes.get(target));
        const text = summary.reason !== undefined || summary.security !== undefined
          ? { publisher_text: { ...(summary.reason !== undefined ? { reason: summary.reason } : {}), ...(summary.security !== undefined ? { security: summary.security } : {}) } }
          : {};
        if (lookup.kind === "held") return answer({ id: name, version: target, status: "quarantined", under_review: true, ...text });
        if (summary.status === "revoked") return answer({ id: name, version: target, status: "revoked", ...text });

        if (caller.kind === "oauth") {
          await recordAuthenticatedDownload(runtime.ports.d1, { packId: pack.id, userId: caller.grant.userId, at: new Date(runtime.tokenClock.now()).toISOString() });
        }
        return answer({
          id: name,
          version: target,
          status: summary.status,
          url: `${origin}/${objectKey(name, "archive", target)}`,
          sha256: lookup.row.sha256,
          attestation_url: `${origin}/${objectKey(name, "attestation", target)}`,
          ...(summary.yanked ? { yanked: true } : {}),
          ...text,
        });
      } catch (error) {
        console.error(`get_download failed: ${error instanceof Error ? error.message : String(error)}`);
        return unavailable();
      }
    },
  );
}

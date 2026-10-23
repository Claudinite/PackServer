import { z } from "zod";
import { Sha256 } from "@packserver/schema";

const Version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

/**
 * `request.json`: everything the Worker hands in besides the archive and the releases. It names
 * the pack, the tree hash sandbox A committed, the pack's `minEngineVersion`, the mirror's oldest
 * release, and for each engine its version, the digest the registry pinned and the tarball's file
 * name under `cn/`.
 */
export const BRequest = z.strictObject({
  pack: z.string().regex(/^@[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/),
  expected_tree_hash: Sha256,
  min_engine_version: Version,
  oldest_engine_in_mirror: Version,
  engines: z
    .array(z.strictObject({ role: z.enum(["newest", "lowest"]), version: Version, sha256: Sha256, file: z.string().regex(/^[A-Za-z0-9._-]{1,100}\.tgz$/) }))
    .min(1)
    .max(2)
    .refine((es) => es.filter((e) => e.role === "newest").length === 1 && new Set(es.map((e) => e.role)).size === es.length, "exactly one newest engine, at most one lowest"),
});

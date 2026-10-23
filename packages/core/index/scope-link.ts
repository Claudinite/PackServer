import { RootIndex } from "@packserver/schema";
import { sha256Hex } from "./bytes";
import type { z } from "zod";

export type ScopeLinkResult = { ok: true } | { ok: false; detail: string };

/**
 * cn follows the hash the root names and must find exactly that object: the bytes served hash to
 * the root's entry, and the scope index inside carries the serial the root recorded for it.
 */
export async function checkScopeAgainstRoot(
  root: z.output<typeof RootIndex>,
  scope: string,
  servedBytes: Uint8Array,
  servedScopeIndex: { scope: string; serial: number },
): Promise<ScopeLinkResult> {
  const entry = root.scopes.find((s) => s.scope === scope);
  if (!entry) return { ok: false, detail: `root does not list ${scope}` };
  if ((await sha256Hex(servedBytes)) !== entry.sha256) return { ok: false, detail: "served bytes do not hash to the root's entry" };
  if (servedScopeIndex.scope !== scope) return { ok: false, detail: "scope index is for another scope" };
  if (servedScopeIndex.serial !== entry.serial) return { ok: false, detail: "scope index serial differs from the root's entry" };
  return { ok: true };
}

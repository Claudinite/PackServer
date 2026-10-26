import type { D1 } from "@packserver/ports";
import { judgeHandle, loadHandleFacts, normalizeHandle, type HandleVerdict } from "../identity/handles.ts";

export type ScopeNameVerdict = HandleVerdict;

/** An organisation name follows the rules a handle does: they share one namespace, so a name is free only when neither uses it. */
export async function judgeScopeName(d1: D1, raw: string): Promise<ScopeNameVerdict> {
  const name = normalizeHandle(raw);
  const verdict = judgeHandle(name, await loadHandleFacts(d1, name));
  if (verdict.ok || verdict.reason !== "format") return verdict;
  return { ...verdict, message: verdict.message.replace(/^A handle is/, "A scope name is") };
}

import type { InvocationKind } from "@packserver/schema";

/** One boundary crossing as a scenario reads it: redacted as production's records are, unless `raw`. */
export interface InvocationView {
  kind: InvocationKind;
  target: string;
  op: string;
  effect: "read" | "write" | "external_side_effect";
  request?: unknown;
  result?: unknown;
  /** Which side saw it: a Worker's own record, or the harness observing the wire. */
  seenBy: "worker" | "harness";
}

export interface InvocationFilter {
  kind?: InvocationKind | InvocationKind[];
  target?: string;
  effect?: InvocationView["effect"];
  /** The pre-redaction view; in-process only, and never in a probe-safe scenario. */
  raw?: boolean;
}

export interface RecorderView {
  invocations(filter?: InvocationFilter): Promise<InvocationView[]>;
}

interface EnvelopeLike {
  v: number;
  invocations: Array<Omit<InvocationView, "seenBy">>;
}

/** A Worker's record sink writes each envelope as one JSON log line. */
export function invocationsFromLogs(lines: Iterable<string>): InvocationView[] {
  const out: InvocationView[] = [];
  for (const line of lines) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const envelope = parsed as Partial<EnvelopeLike>;
    if (envelope.v !== 1 || !Array.isArray(envelope.invocations)) continue;
    for (const inv of envelope.invocations) {
      out.push({ kind: inv.kind, target: inv.target, op: inv.op, effect: inv.effect, request: inv.request, result: inv.result, seenBy: "worker" });
    }
  }
  return out;
}

export function filterInvocations(all: InvocationView[], filter: InvocationFilter = {}): InvocationView[] {
  const kinds = filter.kind === undefined ? null : new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind]);
  return all.filter(
    (i) => (!kinds || kinds.has(i.kind)) && (filter.target === undefined || i.target === filter.target) && (filter.effect === undefined || i.effect === filter.effect),
  );
}

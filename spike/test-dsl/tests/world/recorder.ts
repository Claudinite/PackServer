// A log of every invocation that crossed a boundary during a scenario:
// outbound HTTP as the fakes saw it, and storage reads/writes as the Workers
// reported them. Scenarios assert on it in domain terms (world.recorder.writes()).
export type Invocation = {
  seq: number;
  kind: "d1" | "r2" | "http" | "service";
  target: string;
  op: string;
  request?: unknown;
  result?: unknown;
  effect?: "read" | "write";
  /** who observed it: the fake (outside the system) or the Worker itself (inside) */
  seenBy: "fake" | "worker";
};

export class Recorder {
  private seq = 0;
  readonly entries: Invocation[] = [];

  add(inv: Omit<Invocation, "seq">): void {
    this.entries.push({ seq: ++this.seq, ...inv });
  }
  clear(): void {
    this.entries.length = 0;
    this.seq = 0;
  }
  ofKind(kind: Invocation["kind"]): Invocation[] {
    return this.entries.filter((e) => e.kind === kind);
  }
  writes(): Invocation[] {
    return this.entries.filter((e) => e.effect === "write");
  }
  external(): Invocation[] {
    return this.entries.filter((e) => e.seenBy === "fake");
  }
  /** A compact, order-preserving fingerprint of the run, the thing a wet-run/dry-run diff would compare. */
  trace(): string[] {
    return this.entries.map((e) => `${e.seenBy}:${e.kind}:${e.target}:${e.op}`);
  }
}

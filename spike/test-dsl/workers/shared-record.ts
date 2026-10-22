// Tiny "invocation record" emitter shared by both Workers.
// In production this would go to a log sink / Analytics Engine; under the test
// harness the driver harvests these lines from server.getLogs(). This is the seed
// of the wet-run/dry-run recording the release plan talks about.
export type Invocation = {
  kind: "d1" | "r2" | "http" | "service";
  target: string;        // e.g. "packs", "ARCHIVES", "llm.test"
  op: string;            // e.g. "insert", "put", "POST /validate"
  request?: unknown;
  result?: unknown;
  effect?: "read" | "write";
};
export const REC_PREFIX = "@@REC ";
export function record(inv: Invocation): void {
  console.log(REC_PREFIX + JSON.stringify(inv));
}

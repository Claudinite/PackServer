import type { RulesVersion } from "@packserver/rules";
import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "./engine/rules.ts";
import type { ProseChunk, ProseScreenResult } from "./prose-screen/index.ts";

/** A question the screen answered that the rules version has no threshold for, so there is nothing to compare it with. */
export class UnknownQuestion extends Error {
  readonly question: string;
  constructor(question: string) {
    super(`the rules version has no threshold for question ${question}`);
    this.question = question;
  }
}

export interface Tripped {
  chunk: string;
  question: string;
}

export interface ThresholdResult {
  /** What the publisher and the public see: held, and where. Never the question, the probability or the threshold. */
  findings: Finding[];
  /** What an admin also sees. The numbers stay in the stored report only. */
  tripped: Tripped[];
}

const QUOTE_CHARS = 160;

/**
 * Step 11: the outcome is computed from the returned probabilities and the rules version's
 * thresholds alone. An answer above its threshold holds the version, once per chunk; an answer at
 * or below it passes. Findings the implementation reached on its own pass through unchanged.
 */
export function applyThresholds(result: ProseScreenResult, chunks: readonly ProseChunk[], rules: RulesVersion, make: MakeFinding): ThresholdResult {
  const findings: Finding[] = [...result.findings];
  const tripped: Tripped[] = [];
  for (const answered of result.chunks) {
    const chunk = chunks.find((c) => c.id === answered.id);
    if (!chunk) throw new Error(`the screen answered for chunk ${answered.id}, which it was not given`);
    let flagged = false;
    for (const [question, probability] of Object.entries(answered.probabilities)) {
      const threshold = rules.thresholds.questions[question];
      if (threshold === undefined) throw new UnknownQuestion(question);
      if (probability > threshold) {
        tripped.push({ chunk: chunk.id, question });
        flagged = true;
      }
    }
    if (flagged) {
      findings.push(
        make("prose-screen.flagged", {
          file: chunk.file,
          line: chunk.start_line,
          quote: chunk.text.slice(0, QUOTE_CHARS),
          hint: "The prose screen flagged this passage; an admin will decide.",
        }),
      );
    }
  }
  return { findings, tripped };
}

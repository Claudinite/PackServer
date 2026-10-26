import type { Finding } from "@packserver/schema";

/** A span of one publisher-written file; the screen reads it as data and never as an instruction. */
export interface ProseChunk {
  id: string;
  file: string;
  start_line: number;
  end_line: number;
  text: string;
}

export interface ProseScreenResult {
  /** `static-only`, or the name of the model implementation. */
  implementation: string;
  question_set_version: string;
  model_version: string | null;
  cost_usd: number | null;
  /** Per chunk, the probability the screen gave each question. Empty for an implementation that asks none. */
  chunks: Array<{ id: string; probabilities: Record<string, number> }>;
  /** Findings the implementation reached on its own, with the class the rules give them. */
  findings: Finding[];
}

/**
 * The prose screen. Whatever the implementation, it can only hold: it never fails or rejects a
 * version and never contributes to the score. Code, not the screen, compares what it returns with
 * the rules version's thresholds.
 */
export interface ProseScreen {
  readonly implementation: string;
  /** Whether `screen` reads the chunks; an implementation that does not is spared the cost of building them. */
  readonly readsText: boolean;
  screen(chunks: readonly ProseChunk[], questionSetVersion: string): Promise<ProseScreenResult>;
}

/** The launch implementation: the step-5 heuristics are the screen, and no probability exists. */
export function staticOnly(stepFiveFindings: readonly Finding[]): ProseScreen {
  return {
    implementation: "static-only",
    readsText: false,
    async screen(_chunks, questionSetVersion) {
      return { implementation: "static-only", question_set_version: questionSetVersion, model_version: null, cost_usd: null, chunks: [], findings: [...stepFiveFindings] };
    },
  };
}

/** The largest input of one screen call, in tokens at four bytes to a token (REQ-VAL-036). */
export const CHUNK_TOKENS = 28_000;
const BYTES_PER_TOKEN = 4;

const encoder = new TextEncoder();

/**
 * Splits publisher text into chunks of at most `maxTokens`, on line boundaries, each carrying its
 * file and line range. A single line longer than a chunk is cut inside the line, so nothing is
 * ever dropped.
 */
export function chunkFiles(files: ReadonlyArray<{ path: string; text: string }>, maxTokens = CHUNK_TOKENS): ProseChunk[] {
  const limit = maxTokens * BYTES_PER_TOKEN;
  const chunks: ProseChunk[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    let buffer: string[] = [];
    let bytes = 0;
    let start = 1;
    let last = 1;
    const flush = () => {
      if (buffer.length === 0) return;
      chunks.push({ id: `${chunks.length + 1}`, file: file.path, start_line: start, end_line: last, text: buffer.join("\n") });
      buffer = [];
      bytes = 0;
    };
    lines.forEach((line, i) => {
      const lineNo = i + 1;
      for (const piece of cut(line, limit)) {
        const size = encoder.encode(piece).length + 1;
        if (buffer.length > 0 && bytes + size > limit) flush();
        if (buffer.length === 0) start = lineNo;
        buffer.push(piece);
        bytes += size;
        last = lineNo;
      }
    });
    flush();
  }
  return chunks;
}

/** Pieces of a line that each fit the limit in bytes; a code point is never split. */
function cut(line: string, limit: number): string[] {
  if (encoder.encode(line).length < limit) return [line];
  const pieces: string[] = [];
  let piece = "";
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n >= limit) {
      pieces.push(piece);
      piece = "";
      size = 0;
    }
    piece += ch;
    size += n;
  }
  pieces.push(piece);
  return pieces;
}

/**
 * A chunk as a model sees it: inside delimiters carrying a per-run nonce, with its file and line
 * range. A chunk that happens to contain the nonce cannot be delimited safely and is refused.
 */
export function delimited(chunk: ProseChunk, nonce: string): string {
  if (chunk.text.includes(nonce)) throw new Error("the chunk contains the run's nonce");
  return `<<<${nonce} data file=${JSON.stringify(chunk.file)} lines=${chunk.start_line}-${chunk.end_line}>>>\n${chunk.text}\n<<<${nonce} end>>>`;
}

import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { isProse, matchesOf, type Doc } from "./doc.ts";

// Gaps and repeats are bounded: a hostile line costs a fixed amount per start position.
const INJECTION: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\s{1,8}(?:(?:all|any|the|your|every)\s{1,8}){0,4}(?:previous|prior|above|earlier|preceding|system|safety|original)\s{1,8}(?:instructions?|rules?|prompts?|guidelines?|constraints?|messages?)/gi,
  /\b(?:disregard|forget)\s{1,8}(?:everything|all)\b[^.\n]{0,30}\b(?:above|before|told|instructed)/gi,
  /\byou\s{1,8}are\s{1,8}now\s{1,8}(?:in\s{1,8})?(?:(?:a|an|the)\s{1,8})?(?:\w{1,20}\s{1,8}){0,2}(?:mode|assistant|agent|system|dan|root|admin)\b/gi,
  /\b(?:do\s{1,8}not|don'?t|never)\s{1,8}(?:tell|inform|mention|reveal|show|alert|notify|let)\s{1,8}(?:this\s{1,8}to\s{1,8})?the\s{1,8}(?:user|human|developer|operator|owner)/gi,
  /\bwithout\s{1,8}(?:telling|informing|notifying|alerting|asking)\s{1,8}the\s{1,8}(?:user|human|developer|operator|owner)/gi,
  /\b(?:disable|turn\s{1,8}off|circumvent|evade|bypass)\s{1,8}(?:(?:all|any|the|every)\s{1,8}){0,3}(?:safety|security|guards?|validation|sandbox|permission(?:s|\s{1,8}prompts?)?)\b/gi,
  /(?:^|\s)<\s{0,4}(?:important|system|instructions?|secret)\s{0,4}>/gi,
  /\[\s{0,4}(?:INST|SYSTEM)\s{0,4}\]|<\|(?:im_start|system|endoftext)\|>/gi,
  /\b(?:reveal|print|output|repeat|leak)\s{1,8}(?:your|the)\s{1,8}(?:system\s{1,8}prompt|hidden\s{1,8}instructions?|initial\s{1,8}instructions?)/gi,
  /\bbefore\s{1,8}(?:using|calling|running)\s{1,8}this\s{1,8}(?:tool|skill|pack)\b[^.\n]{0,60}\b(?:read|send|copy|upload|cat)\b/gi,
  /\b(?:auto[- ]?approve|approve\s{1,8}without\s{1,8}(?:asking|confirmation|review)|dangerously-skip-permissions|bypassPermissions)\b/gi,
  /\bact\s{1,8}outside\s{1,8}(?:the|this)\s{1,8}repo(?:sitory)?\b|\bmodify\s{1,8}files\s{1,8}outside\s{1,8}(?:the|this)\s{1,8}repo/gi,
];

const REVIEWER = "(?:reviewers?|validators?|auditors?|evaluators?|moderators?|scanners?|admins?|administrators?|checkers?|screeners?|(?:ai|llm|model|automated|security)\\s{1,8}(?:reviewers?|evaluators?|scanners?|systems?|models?)|ai|llm)";

const REVIEWER_ADDRESSED: readonly RegExp[] = [
  new RegExp(`\\b(?:note|message|attention|notice|instructions?|hello|hi|dear|hey|comment)s?\\s{1,8}(?:to|for)\\s{1,8}(?:(?:the|any|our)\\s{1,8})?${REVIEWER}\\b`, "gi"),
  new RegExp(`\\b(?:dear|hello|hi|hey|attention)[,:]?\\s{1,8}(?:the\\s{1,8})?${REVIEWER}\\b`, "gi"),
  new RegExp(`\\bif\\s{1,8}you\\s{1,8}are\\s{1,8}(?:a|an|the)\\s{1,8}(?:\\w{1,20}\\s{1,8}){0,2}${REVIEWER}\\b`, "gi"),
  new RegExp(`\\b(?:as|when)\\s{1,8}(?:a|an|the)\\s{1,8}${REVIEWER}\\s{0,8},?\\s{0,8}you\\s{1,8}(?:should|must|will|can)`, "gi"),
  new RegExp(`\\b${REVIEWER}[,:]?\\s{1,8}(?:please\\s{1,8})?(?:approve|pass|accept|ignore|skip|do\\s{1,8}not\\s{1,8}flag|don'?t\\s{1,8}flag|mark)\\b`, "gi"),
  /\bthis\s{1,8}(?:pack|file|skill|code|package|version)\s{1,8}is\s{1,8}(?:safe|benign|harmless|approved|trusted|verified|clean)\b/gi,
  /\b(?:please\s{1,8})?(?:mark|treat|rate|score|classify|flag)\s{1,8}(?:this|it)\s{1,8}as\s{1,8}(?:safe|benign|clean|approved|passing|passed)\b/gi,
  /\b(?:do\s{1,8}not|don'?t|never)\s{1,8}(?:flag|report|block|reject|hold)\s{1,8}(?:this|it|the\s{1,8}(?:pack|file|version))\b/gi,
  /\b(?:approve|pass|accept)\s{1,8}this\s{1,8}(?:pack|version|submission|upload)\b/gi,
];

const CREDENTIAL_SINK: readonly RegExp[] = [
  /\b(?:read|cat|print|echo|dump|copy|show|include|collect|gather)\b[^.\n]{0,40}(?:\.env\b|~\/\.(?:ssh|aws|npmrc|netrc|config\/gh|docker)|\bid_rsa\b|\bcredentials\.json\b|\bkeychain\b)/gi,
  /\b(?:send|post|upload|forward|attach|submit|transmit|email|exfiltrate)\b[^.\n]{0,60}\b(?:secrets?|credentials?|api[ _-]?keys?|access[ _-]?tokens?|auth(?:entication)?\s{1,8}tokens?|passwords?|private\s{1,8}keys?|environment\s{1,8}variables?|env\s{1,8}vars?)\b/gi,
  /\b(?:secrets?|credentials?|api[ _-]?keys?|tokens?|passwords?|private\s{1,8}keys?)\b[^.\n]{0,30}\b(?:to|at|into)\s{1,8}(?:https?:\/\/|the\s{1,8}(?:url|endpoint|webhook|server))/gi,
];

// An instruction to the agent, outside fenced code. A code sample that happens to call fetch() is not one.
const NETWORK_SINK: readonly RegExp[] = [
  /\b(?:send|post|upload|forward|transmit|report|submit|push|stream|exfiltrate)\b[^.\n]{0,80}\b(?:to|at|via)\s{1,8}(?:the\s{1,8}(?:(?:url|endpoint|server)\s{1,8})?)?<?https?:\/\//gi,
  /\b(?:run|execute|call|invoke|issue|use)\b[^.\n]{0,60}\b(?:curl|wget)\b[^\n]{0,100}(?:-X\s{0,4}POST|--data\b|-d\s|--upload-file|-T\s|--form\b|-F\s)/gi,
  /\b(?:send|post|upload|forward|transmit)\b[^.\n]{0,80}\b(?:to|at)\s{1,8}(?:a\s{1,8}|an\s{1,8}|the\s{1,8})?(?:remote|external|third[- ]party)\s{1,8}(?:server|endpoint|host|service|webhook)\b/gi,
];

function* allOf(res: readonly RegExp[], text: string): Generator<RegExpExecArray> {
  for (const re of res) yield* matchesOf(re, text);
}

/** Heuristics over every publisher-written string; a hit in the pitch or a tag fails outright. */
export function injectionFindings(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    const t = d.safe;
    for (const [rule, patterns] of [["text.injection", INJECTION], ["text.reviewer-addressed", REVIEWER_ADDRESSED]] as const) {
      for (const m of allOf(patterns, t)) {
        const field = d.fieldAt(m.index);
        const strict = field === "pitch" || field === "tags";
        const quote = excerpt(t, m.index, m[0].length);
        const where = { file: d.file, line: d.lineAt(m.index), quote };
        if (strict) {
          out.push(make("text.injection-pitch-tag", { ...where, hint: `The ${field === "tags" ? "tag" : "pitch"} reads as an instruction to an agent or a reviewer. Describe the pack in plain words.` }));
        } else if (rule === "text.injection") {
          out.push(make(rule, { ...where, hint: "This reads as an instruction that steers the agent away from its user. Remove it, or ask for a manual review." }));
        } else {
          out.push(make(rule, { ...where, hint: "Text addressed to a reviewer or an automated evaluator has no place in a pack. Remove it, or ask for a manual review." }));
        }
      }
    }
  }
  return out;
}

/** Prose that tells the agent to read or send a credential, or to send data to a network address. */
export function sinkFindings(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    if (!isProse(d.file)) continue;
    for (const m of allOf(CREDENTIAL_SINK, d.safe)) {
      out.push(make("text.credential-sink-in-prose", { file: d.file, line: d.lineAt(m.index), quote: excerpt(d.safe, m.index, m[0].length), hint: "Prose must not tell the agent to read or send credentials or secrets." }));
    }
    for (const m of allOf(NETWORK_SINK, d.prose)) {
      out.push(make("text.network-sink-in-prose", { file: d.file, line: d.lineAt(m.index), quote: excerpt(d.prose, m.index, m[0].length), hint: "Prose must not tell the agent to send data to a network destination." }));
    }
  }
  return out;
}

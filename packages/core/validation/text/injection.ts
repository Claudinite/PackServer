import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { isProse, type Unit } from "./units.ts";

const INJECTION: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|every\s+)*(?:previous|prior|above|earlier|preceding|system|safety|original)\s+(?:instructions?|rules?|prompts?|guidelines?|constraints?|messages?)/i,
  /\b(?:disregard|forget)\s+(?:everything|all)\b[^.\n]{0,30}\b(?:above|before|told|instructed)/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:a\s+|an\s+|the\s+)?(?:\w+\s+){0,2}(?:mode|assistant|agent|system|dan|root|admin)\b/i,
  /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention|reveal|show|alert|notify|let)\s+(?:this\s+to\s+)?the\s+(?:user|human|developer|operator|owner)/i,
  /\bwithout\s+(?:telling|informing|notifying|alerting|asking)\s+the\s+(?:user|human|developer|operator|owner)/i,
  /\b(?:disable|turn\s+off|skip|remove|circumvent|evade)\s+(?:all\s+|any\s+|the\s+|every\s+)*(?:safety|security|guards?|checks?|hooks?|validation|sandbox|permission(?:s|\s+prompts?)?)\b(?!\s+(?:fixtures?|tests?))/i,
  /(?:^|\s)<\s*(?:important|system|instructions?|secret)\s*>/i,
  /\[\s*(?:INST|SYSTEM)\s*\]|<\|(?:im_start|system|endoftext)\|>/i,
  /\b(?:reveal|print|output|repeat|leak)\s+(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions?|initial\s+instructions?)/i,
  /\bbefore\s+(?:using|calling|running)\s+this\s+(?:tool|skill|pack)\b[^.\n]{0,60}\b(?:read|send|copy|upload|cat)\b/i,
  /\b(?:auto[- ]?approve|approve\s+without\s+(?:asking|confirmation|review)|dangerously-skip-permissions|bypassPermissions)\b/i,
  /\bact\s+outside\s+(?:the|this)\s+repo(?:sitory)?\b|\bmodify\s+files\s+outside\s+(?:the|this)\s+repo/i,
];

const REVIEWER = "(?:reviewers?|validators?|auditors?|evaluators?|moderators?|scanners?|admins?|administrators?|checkers?|screeners?|(?:ai|llm|model|automated|security)\\s+(?:reviewers?|evaluators?|scanners?|systems?|models?)|ai|llm)";

const REVIEWER_ADDRESSED: readonly RegExp[] = [
  new RegExp(`\\b(?:note|message|attention|notice|instructions?|hello|hi|dear|hey|comment)s?\\s+(?:to|for)\\s+(?:the\\s+|any\\s+|our\\s+)?${REVIEWER}\\b`, "i"),
  new RegExp(`\\b(?:dear|hello|hi|hey|attention)[,:]?\\s+(?:the\\s+)?${REVIEWER}\\b`, "i"),
  new RegExp(`\\bif\\s+you\\s+are\\s+(?:a|an|the)\\s+(?:\\w+\\s+){0,2}${REVIEWER}\\b`, "i"),
  new RegExp(`\\b(?:as|when)\\s+(?:a|an|the)\\s+${REVIEWER}\\s*,?\\s+you\\s+(?:should|must|will|can)`, "i"),
  new RegExp(`\\b${REVIEWER}[,:]?\\s+(?:please\\s+)?(?:approve|pass|accept|ignore|skip|do\\s+not\\s+flag|don'?t\\s+flag|mark)\\b`, "i"),
  /\b(?:this\s+(?:pack|file|skill|code|package|version)\s+is\s+(?:safe|benign|harmless|approved|trusted|verified|clean|reviewed)|(?:already|pre-?)\s*(?:reviewed|approved|audited|vetted))\b/i,
  /\b(?:please\s+)?(?:mark|treat|rate|score|classify|flag)\s+(?:this|it)\s+as\s+(?:safe|benign|clean|approved|passing|passed)\b/i,
  /\b(?:do\s+not|don'?t|never)\s+(?:flag|report|block|reject|hold)\s+(?:this|it|the\s+(?:pack|file|version))\b/i,
  /\b(?:approve|pass|accept)\s+this\s+(?:pack|version|submission|upload)\b/i,
];

const CREDENTIAL_SINK: readonly RegExp[] = [
  /\b(?:read|cat|print|echo|dump|copy|show|include|collect|gather)\b[^.\n]{0,40}(?:\.env\b|~\/\.(?:ssh|aws|npmrc|netrc|config\/gh|docker)|\bid_rsa\b|\bcredentials\.json\b|\bkeychain\b)/i,
  /\b(?:send|post|upload|forward|attach|submit|transmit|email|exfiltrate)\b[^.\n]{0,60}\b(?:secrets?|credentials?|api[ _-]?keys?|access[ _-]?tokens?|auth(?:entication)?\s+tokens?|passwords?|private\s+keys?|environment\s+variables?|env\s+vars?)\b/i,
  /\b(?:secrets?|credentials?|api[ _-]?keys?|tokens?|passwords?|private\s+keys?)\b[^.\n]{0,30}\b(?:to|at|into)\s+(?:https?:\/\/|the\s+(?:url|endpoint|webhook|server))/i,
];

const NETWORK_SINK: readonly RegExp[] = [
  /\b(?:send|post|upload|forward|transmit|report|submit|push|stream|exfiltrate)\b[^.\n]{0,80}\b(?:to|at|via)\s+(?:the\s+(?:url\s+|endpoint\s+|server\s+)?)?<?https?:\/\//i,
  /\b(?:curl|wget)\b[^\n]*(?:-X\s*POST|--data\b|-d\s|--upload-file|-T\s|--form\b|-F\s)/i,
  /\b(?:fetch|http\.Post|axios\.post|requests\.post|XMLHttpRequest|navigator\.sendBeacon)\s*\(/,
  /\b(?:send|post|upload|forward|transmit)\b[^.\n]{0,80}\b(?:to|at)\s+(?:a\s+|an\s+|the\s+)?(?:remote|external|third[- ]party)\s+(?:server|endpoint|host|service|webhook)\b/i,
];


function first(res: readonly RegExp[], text: string): { index: number; length: number } | null {
  for (const re of res) {
    const m = re.exec(text);
    if (m) return { index: m.index, length: m[0].length };
  }
  return null;
}

/** Heuristics over every publisher-written string; a hit in the pitch or a tag fails outright. */
export function injectionFindings(units: readonly Unit[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const u of units) {
    const strict = u.field === "pitch" || u.field === "tags";
    const injection = first(INJECTION, u.text);
    const reviewer = first(REVIEWER_ADDRESSED, u.text);
    const where = { file: u.file, line: u.line };
    if (strict && (injection || reviewer)) {
      const hit = (injection ?? reviewer)!;
      out.push(make("text.injection-pitch-tag", { ...where, quote: excerpt(u.text, hit.index, hit.length), hint: `The ${u.field === "tags" ? "tag" : "pitch"} reads as an instruction to an agent or a reviewer. Describe the pack in plain words.` }));
      continue;
    }
    if (injection) out.push(make("text.injection", { ...where, quote: excerpt(u.text, injection.index, injection.length), hint: "This reads as an instruction that steers the agent away from its user. Remove it, or ask for a manual review." }));
    if (reviewer) out.push(make("text.reviewer-addressed", { ...where, quote: excerpt(u.text, reviewer.index, reviewer.length), hint: "Text addressed to a reviewer or an automated evaluator has no place in a pack. Remove it, or ask for a manual review." }));
  }
  return out;
}

/** Prose that tells the agent to read or send a credential, or to send data to a network address. */
export function sinkFindings(units: readonly Unit[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const u of units) {
    if (!isProse(u.file)) continue;
    const credential = first(CREDENTIAL_SINK, u.text);
    if (credential) out.push(make("text.credential-sink-in-prose", { file: u.file, line: u.line, quote: excerpt(u.text, credential.index, credential.length), hint: "Prose must not tell the agent to read or send credentials or secrets." }));
    const network = first(NETWORK_SINK, u.text);
    if (network) out.push(make("text.network-sink-in-prose", { file: u.file, line: u.line, quote: excerpt(u.text, network.index, network.length), hint: "Prose must not tell the agent to send data to a network destination." }));
  }
  return out;
}

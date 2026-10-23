import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import type { Unit } from "./units.ts";

const SECRET_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/ },
  { kind: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "API key", re: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "Stripe key", re: /\b[sr]k_live_[0-9A-Za-z]{20,}/ },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "Cloudflare API token", re: /\b(?:cf|cloudflare)[_-]?(?:api[_-]?)?token\s*[:=]\s*["']?[A-Za-z0-9_-]{40}\b/i },
];

const placeholder = (kind: string, match: string) => kind !== "private key" && new Set(match).size < 8;

/**
 * Rule, file and line only: the matched text is never copied into a finding, a hint or an error.
 */
export function scanSecrets(units: readonly Unit[], make: MakeFinding): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const u of units) {
    for (const { kind, re } of SECRET_PATTERNS) {
      const m = re.exec(u.text);
      if (!m || placeholder(kind, m[0])) continue;
      const key = `${u.file}:${u.line}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(make("text.secret", { file: u.file, line: u.line, hint: `A ${kind} appears here. Remove it and rotate it: it is exposed once published or committed.` }));
    }
  }
  return out;
}

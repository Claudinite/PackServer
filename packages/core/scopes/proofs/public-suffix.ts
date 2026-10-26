import { EXCEPTION_RULES, PLAIN_RULES, WILDCARD_RULES } from "./public-suffix-list.ts";

const set = (rules: string): ReadonlySet<string> => new Set(rules.split(" "));
const PLAIN = set(PLAIN_RULES);
const WILDCARD = set(WILDCARD_RULES);
const EXCEPTION = set(EXCEPTION_RULES);

export type DomainJudgement =
  | { ok: true; domain: string }
  | { ok: false; reason: "format" | "public_suffix"; message: string };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const NOT_A_NAME = /[\s/:?#@\\%[\]]/;

/**
 * How many trailing labels of `labels` the Public Suffix List makes the public suffix: the longest
 * matching rule, an exception rule winning and dropping its first label, and a name no rule covers
 * counting its last label as the suffix.
 */
function suffixLength(labels: readonly string[]): number {
  let longest = 1;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (EXCEPTION.has(candidate)) return labels.length - i - 1;
    if (PLAIN.has(candidate) || (i + 1 < labels.length && WILDCARD.has(labels.slice(i + 1).join(".")))) longest = Math.max(longest, labels.length - i);
  }
  return longest;
}

/** True when `host` is itself a suffix that unrelated parties register under, or a bare top-level domain. */
export function isPublicSuffix(host: string): boolean {
  const labels = host.split(".");
  return suffixLength(labels) >= labels.length;
}

/**
 * The host a person typed, as the host to prove: lower-case ASCII (a pasted Unicode name becomes
 * punycode), no trailing dot, labels of letters, digits and hyphens. A subdomain is proven as
 * itself (`docs.acme.com` is not `acme.com`). A name a URL parser would read as an IP address
 * (`0x7f.1`, `2130706433`) is refused, whatever its spelling.
 */
export function judgeDomain(input: string): DomainJudgement {
  const refused: DomainJudgement = { ok: false, reason: "format", message: "Give a domain name such as acme.com (no scheme, port or path)." };
  const typed = input.trim().toLowerCase().replace(/\.$/, "");
  if (typed === "" || NOT_A_NAME.test(typed)) return refused;
  let host: string;
  try {
    host = new URL(`https://${typed}`).hostname;
  } catch {
    return refused;
  }
  const ascii = !/\P{ASCII}/u.test(typed);
  const labels = host.split(".");
  const last = labels[labels.length - 1]!;
  if (host === "" || host.length > 253 || (ascii && host !== typed) || !labels.every((l) => LABEL.test(l)) || /^(0x[0-9a-f]*|[0-9]+)$/.test(last)) return refused;
  if (isPublicSuffix(host)) {
    return { ok: false, reason: "public_suffix", message: `${host} is a public suffix that many unrelated parties register under; prove a domain you own.` };
  }
  return { ok: true, domain: host };
}

/** The label a person registered under the host's public suffix: `acme` for `docs.acme.com` and for `acme.co.uk`. */
export function registrableLabel(host: string): string {
  const labels = host.split(".");
  const at = labels.length - suffixLength(labels) - 1;
  return labels[Math.max(at, 0)]!;
}

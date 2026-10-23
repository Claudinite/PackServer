// The Logpush Transformer for the http_requests jobs: rendering its SQL, and a JS evaluator of the
// ClientNetwork CASE that reads its patterns out of the rendered SQL itself.
//
// ClientNetwork is a consistent key, not RFC 5952 canonical (the /48 of 2001:db8::1 is
// "2001:db8:0::/48"); readers only compare keys. An IPv4-mapped address (::ffff:a.b.c.d) lands in
// 0:0:0::/48, which is harmless while Cloudflare logs IPv4 clients as dotted quads.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..");

export const readTemplate = (spec, job) => readFileSync(join(DIR, spec.logpush.transformerDir, job.transformer), "utf8");

export function renderTransformer(template, job, hosts) {
  const quoted = hosts.map((h) => {
    if (!/^[a-z0-9.-]+$/.test(h)) throw new Error(`host ${h} cannot be written into SQL`);
    return `'${h}'`;
  });
  return template
    .replaceAll("{{FIELDS}}", job.fields.join(", "))
    .replaceAll("{{HOSTS}}", quoted.join(", "))
    .replaceAll("{{WHERE}}", job.where)
    .trimEnd();
}

// SQL replacement text uses \1; JS uses $1.
const jsReplacement = (r) => r.replace(/\\(\d)/g, "$$$1");

export function parseNetworkCase(sql) {
  const norm = sql.match(/regexp_replace\(ip, '([^']*)', '([^']*)', 'g'\) AS n/);
  if (!norm) throw new Error("no leading-zero normalisation of ip into n");
  const caseBody = sql.match(/CASE([\s\S]*?)END AS ClientNetwork/)?.[1];
  if (!caseBody) throw new Error("no CASE ... END AS ClientNetwork");
  if (!/\bELSE NULL\s*$/.test(caseBody.trimEnd())) throw new Error("the CASE must end with ELSE NULL so it fails closed");
  const branches = [];
  const re = /WHEN (?:regexp_like\((ip|n), '([^']*)'\) THEN regexp_replace\(\1, '([^']*)', '([^']*)'\)|starts_with\(n, '([^']*)'\) THEN '([^']*)')/g;
  let consumed = "";
  for (const m of caseBody.matchAll(re)) {
    consumed += m[0];
    if (m[1]) {
      if (!m[2].startsWith("^")) throw new Error(`guard ${m[2]} is not anchored`);
      if (!m[3].startsWith("^") || !m[3].endsWith("$")) throw new Error(`pattern ${m[3]} must match the whole value, or regexp_replace would return a raw IP unchanged`);
      branches.push({ on: m[1], guard: new RegExp(m[2]), pattern: new RegExp(m[3]), replacement: jsReplacement(m[4]) });
    } else {
      branches.push({ on: "n", prefix: m[5], literal: m[6] });
    }
  }
  const stripped = caseBody.replace(/\s+/g, "").replace(/ELSENULL$/, "");
  if (stripped !== consumed.replace(/\s+/g, "")) throw new Error("the CASE holds a branch this evaluator does not understand; every branch must be guarded");
  return { norm: { pattern: new RegExp(norm[1], "g"), replacement: jsReplacement(norm[2]) }, branches };
}

export function evaluateNetwork(parsed, clientIp) {
  if (clientIp == null) return null;
  const ip = String(clientIp).toLowerCase();
  const n = ip.replace(parsed.norm.pattern, parsed.norm.replacement);
  for (const b of parsed.branches) {
    const subject = b.on === "ip" ? ip : n;
    if (b.literal !== undefined) {
      if (subject.startsWith(b.prefix)) return b.literal;
    } else if (b.guard.test(subject)) {
      return subject.replace(b.pattern, b.replacement);
    }
  }
  return null;
}

// Problems with the rendered SQL: the vectors it must satisfy, and that no raw IP can escape.
export function checkTransformer(sql, vectors, forbiddenFields) {
  const problems = [];
  let parsed;
  try {
    parsed = parseNetworkCase(sql);
  } catch (e) {
    return [`transformer: ${e.message}`];
  }
  for (const v of vectors) {
    const got = evaluateNetwork(parsed, v.ip);
    if (got !== v.network) problems.push(`transformer: ${JSON.stringify(v.ip)} gives ${JSON.stringify(got)}, expected ${JSON.stringify(v.network)}`);
    if (got !== null && got === v.ip) problems.push(`transformer: ${JSON.stringify(v.ip)} passed through unchanged`);
  }
  const mentions = sql.match(/\bClientIP\b/g) ?? [];
  if (mentions.length !== 1 || !sql.includes("lower(ClientIP) AS ip")) problems.push("transformer: ClientIP may appear only once, as lower(ClientIP) AS ip");
  const finalSelect = sql.slice(sql.lastIndexOf("\nSELECT"));
  for (const f of forbiddenFields) {
    if (new RegExp(`\\b${f}\\b`).test(finalSelect)) problems.push(`transformer: the output selects ${f}`);
  }
  if (/\bSELECT\s+\*/i.test(finalSelect) || /,\s*(ip|n)\s*,/.test(finalSelect)) problems.push("transformer: the output must not select the intermediate ip or n");
  return problems;
}

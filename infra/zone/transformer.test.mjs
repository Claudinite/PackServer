import { describe, expect, it } from "vitest";
import { evaluateNetwork, parseNetworkCase, readTemplate, renderTransformer } from "./lib/transformer.mjs";
import { envHosts, loadSpec, validateSpec } from "./lib/spec.mjs";

// These tests run the ClientNetwork CASE through a JS evaluator that reads its patterns out of the
// rendered SQL, not through DataFusion (which Logpush runs and which is not available in CI).
// transformers/verify-datafusion.py runs the same vectors in a real DataFusion.
const spec = loadSpec();
const job = spec.logpush.jobs.find((j) => j.key === "http-cache-hits");
const sql = renderTransformer(readTemplate(spec, job), job, envHosts("production"));
const parsed = parseNetworkCase(sql);

describe("the ClientNetwork expression", () => {
  it.each(spec.logpush.vectors.map((v) => [v.ip, v.network]))("%j gives %j", (ip, network) => {
    expect(evaluateNetwork(parsed, ip)).toBe(network);
  });

  it("covers the compressed, upper-case, leading-zero and mapped forms the review named", () => {
    const ips = spec.logpush.vectors.map((v) => v.ip);
    for (const ip of ["2001:db8::1", "2001::1", "2001::", "::1", "::", "2001:0db8:0001:abcd::1", "::ffff:192.0.2.1"]) expect(ips).toContain(ip);
    expect(ips.some((ip) => /[A-F]/.test(ip))).toBe(true);
  });

  it("puts two addresses of one /48 in one network and two /48s in two", () => {
    const net = (ip) => evaluateNetwork(parsed, ip);
    expect(net("2001:db8::1")).toBe(net("2001:0db8:0:0:5::9"));
    expect(net("2001:db8::1")).not.toBe(net("2001:db9::1"));
    expect(net("198.51.100.7")).toBe(net("198.51.100.9"));
  });

  it("fails closed: nothing but a network or null comes out, whatever goes in", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = "0123456789abcdefABCDEF:.::-/ gx";
    for (let i = 0; i < 20000; i++) {
      const len = Math.floor(next() * 40);
      let s = "";
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(next() * alphabet.length)];
      const out = evaluateNetwork(parsed, s);
      if (out === null) continue;
      expect(out).toMatch(/^([0-9]+\.[0-9]+\.[0-9]+\.0\/24|[0-9a-f]{1,4}(:[0-9a-f]{1,4}){0,2}::\/48|[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::\/48)$/);
      expect(out).not.toBe(s);
    }
    expect(evaluateNetwork(parsed, null)).toBeNull();
  });

  it("refuses an expression that could pass a raw value through", () => {
    expect(() => parseNetworkCase(sql.replace(/\n\s*ELSE NULL/, ""))).toThrow(/ELSE NULL/);
    const unanchored = sql.replace("'^([0-9]+)\\.([0-9]+)\\.([0-9]+)\\.[0-9]+$'", "'([0-9]+)\\.([0-9]+)\\.([0-9]+)\\.[0-9]+'");
    expect(() => parseNetworkCase(unanchored)).toThrow(/whole value/);
    const unguarded = sql.replace("WHEN starts_with(n, '::') THEN '0:0:0::/48'", "WHEN true THEN n");
    expect(() => parseNetworkCase(unguarded)).toThrow(/branch/);
  });
});

describe("the declarations around the transformer", () => {
  it("are valid", () => {
    expect(validateSpec(spec)).toEqual([]);
  });

  it("reject an http_requests job without a transformer, or a transformer that selects ClientIP", () => {
    const bare = structuredClone(spec);
    delete bare.logpush.jobs[0].transformer;
    expect(validateSpec(bare).join()).toContain("must go through the transformer");

    const wrong = structuredClone(spec);
    wrong.logpush.vectors[1].network = "2001:db8::/48";
    expect(validateSpec(wrong).join()).toContain("2001:db8::1");

    const leaky = structuredClone(spec);
    leaky.logpush.jobs[0].fields.push("ClientIP");
    expect(validateSpec(leaky).join()).toContain("ClientIP");
  });

  it("keep ClientIP forbidden, and no job carries both a filter and a transformer", () => {
    expect(spec.logpush.forbiddenFields).toContain("ClientIP");
    for (const j of spec.logpush.jobs.filter((x) => x.transformer)) expect(typeof j.where).toBe("string");
  });
});

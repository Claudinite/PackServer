// Lint for scenario files: they speak only the World's language (C2), assert strongly and stay
// in plain scenario() calls (C6), and a probe-safe scenario touches nothing a probe may not (C10).
// tools/check-scenarios.mjs reuses VOCABULARY and PROBE_UNSAFE, so the lint and the gate share one list.

export const VOCABULARY = [
  { name: "a URL or host", pattern: /https?:\/\/|\.claudinite\.com|localhost:\d*/ },
  { name: "an endpoint path", pattern: /(?:^|[\s"'`(])\/(?:api|mcp|hooks|oauth|\.well-known|admin)\b/ },
  { name: "an HTTP verb", pattern: /^(?:GET|POST|PUT|PATCH|DELETE)$|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\// },
  { name: "a status code", pattern: /\b(?:status(?:\s+code)?|HTTP|code)\s*:?\s*[1-5]\d\d\b|\b(?:200|201|204|301|302|400|401|403|404|409|410|413|429|451|500|502|503)\b/ },
  { name: "SQL", pattern: /\bSELECT\s[^;]*\sFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/ },
  { name: "a binding name", pattern: /\b(?:D1Database|R2Bucket|KVNamespace|DurableObject|env\.[A-Z]\w+)\b/ },
  { name: "a header name", pattern: /\b(?:X-[A-Z][\w-]*|Cf-[\w-]+|Set-Cookie|Authorization:|Bearer\s)|__Host-/ },
  { name: "a driver primitive", pattern: /\b(?:fetch|callTool|getBy[A-Z]\w*|locator)\s*\(|\bpage\.(?:goto|click|fill|locator)\b/ },
  { name: "a timer or wall clock", pattern: /\b(?:setTimeout|setInterval|Date\.now)\b|\bnew Date\(/ },
];

/** Receivers and verbs a probe-safe scenario never touches unless the probe tenant owns them. */
export const PROBE_UNSAFE = [
  "clock", "telemetry", "recorder", "github", "rules", "delivery", "polar", "proseScreen", "sandbox",
  "mail", "dns", "turnstile", "rekor", "audit", "storage", "database", "validation", "cron",
  "operator.stall", "credits.buy", "credits.beginPurchase", "invite", "inviteLink", "reportAbuse",
  "report", "review", "star", "vote", "requestAccess", "orgs.create", "packs.reserve", "publish",
];

export function vocabularyHit(text) {
  return VOCABULARY.find((v) => v.pattern.test(text))?.name;
}

export function probeUnsafeHit(path) {
  return PROBE_UNSAFE.find((p) => path === p || path.startsWith(`${p}.`));
}

const vocabulary = {
  meta: { type: "problem", schema: [], messages: { banned: "{{what}} in a scenario ({{where}}): say it in the World's vocabulary, and move protocol detail into the World." } },
  create(context) {
    const report = (node, text, where) => {
      const what = vocabularyHit(text);
      if (what) context.report({ node, messageId: "banned", data: { what, where } });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") report(node, node.value, "string");
      },
      TemplateElement(node) {
        report(node, node.value.cooked ?? node.value.raw, "string");
      },
      Program() {
        for (const comment of context.sourceCode.getAllComments()) report(comment, comment.value, "comment");
      },
    };
  },
};

function memberPath(node) {
  const parts = [];
  let cur = node;
  while (cur.type === "MemberExpression" && !cur.computed && cur.property.type === "Identifier") {
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  return cur.type === "Identifier" ? { root: cur.name, path: parts.join(".") } : null;
}

const probeSafePurity = {
  meta: { type: "problem", schema: [], messages: { unsafe: "A probe-safe scenario must not use world.{{path}}: it runs against production through the probe tenant only." } },
  create(context) {
    const stack = [];
    const isScenarioCall = (node) =>
      (node.callee.type === "Identifier" && node.callee.name === "scenario") ||
      (node.callee.type === "MemberExpression" && node.callee.object.name === "scenario");
    const tagsOf = (opts) =>
      opts?.type === "ObjectExpression"
        ? opts.properties.filter((p) => p.key?.name === "tags").flatMap((p) => (p.value.elements ?? []).map((e) => e?.value))
        : [];
    return {
      CallExpression(node) {
        if (!isScenarioCall(node) || !tagsOf(node.arguments[2]).includes("probe-safe")) return;
        const fn = node.arguments[1];
        const param = fn?.params?.[0];
        stack.push({ fn, world: param?.type === "Identifier" ? param.name : "world" });
      },
      "CallExpression:exit"(node) {
        if (stack.length && stack.at(-1).fn === node.arguments[1] && isScenarioCall(node)) stack.pop();
      },
      MemberExpression(node) {
        const active = stack.at(-1);
        if (!active || node.parent.type === "MemberExpression" && node.parent.object === node) return;
        const m = memberPath(node);
        if (m?.root !== active.world) return;
        const hit = probeUnsafeHit(m.path);
        if (hit) context.report({ node, messageId: "unsafe", data: { path: m.path } });
      },
    };
  },
};

const RESTRICTED_SYNTAX = [
  { selector: "CallExpression[callee.name=/^(test|it)$/]", message: "Declare a scenario with scenario(), not test() or it()." },
  { selector: "TryStatement", message: "Expected failures are matchers (toBeRefused and kin); no try/catch in a scenario." },
  { selector: "CallExpression[callee.property.name=/^(skip|only|todo)$/]", message: "No disabled or focused scenarios; the driver skips what it cannot run." },
  { selector: "CallExpression[callee.property.name=/^(toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined)$/]", message: "Assert the value the requirement names." },
  { selector: "MemberExpression[object.name='expect'][property.name='anything']", message: "Assert the value the requirement names." },
  { selector: ":not(Property) > CallExpression[callee.object.name='expect'][callee.property.name='any']", message: "expect.any() only as a field value inside toMatchObject or objectContaining." },
  { selector: "CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual)$/] > Literal[raw=/^[1-5]\\d\\d$/]", message: "A status code in a scenario: assert the outcome the requirement names." },
  { selector: "Property[key.name=/^(status|statusCode)$/] > Literal[raw=/^[1-5]\\d\\d$/]", message: "A status code in a scenario: assert the outcome the requirement names." },
  { selector: "MemberExpression[object.name=/^(env|ctx|page|locator)$/]", message: "A binding or driver primitive in a scenario." },
  { selector: "CallExpression[callee.property.name=/^(callTool|getBy[A-Z]\\w*|exec|prepare)$/]", message: "A driver primitive in a scenario." },
];

export default [
  {
    files: ["scenarios/**/*.scenario.ts"],
    // _*.scenario.ts files prove the harness itself and may reach below the World.
    ignores: ["scenarios/_*.scenario.ts"],
    plugins: { scenarios: { rules: { vocabulary, "probe-safe-purity": probeSafePurity } } },
    rules: {
      "scenarios/vocabulary": "error",
      "scenarios/probe-safe-purity": "error",
      "no-restricted-imports": ["error", { patterns: [{ regex: "^(?!@packserver/test-world$)", message: "Scenarios import only @packserver/test-world." }] }],
      "no-restricted-globals": ["error", "fetch", "Request", "Response", "Headers", "setTimeout", "setInterval", "Date", "process"],
      "no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX],
    },
  },
];

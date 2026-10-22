import { z } from "zod";
import proseScreenJson from "../2026.10.1/prose_screen.json" with { type: "json" };
import questionsJson from "../2026.10.1/questions.json" with { type: "json" };
import scoreJson from "../2026.10.1/score.json" with { type: "json" };
import staticRulesJson from "../2026.10.1/static-rules.json" with { type: "json" };
import thresholdsJson from "../2026.10.1/thresholds.json" with { type: "json" };

const version = z.string().regex(/^\d{4}\.\d+\.\d+$/);

const staticRules = z.object({
  version,
  security_categories: z.array(z.string()),
  rules: z.array(
    z.object({
      id: z.string(),
      class: z.enum(["fail", "hold", "warn"]),
      category: z.string(),
      description: z.string(),
    }),
  ),
});

const score = z.object({
  version,
  parts: z.object({
    context_cost: z.number(),
    skill_structure: z.number(),
    checks: z.number(),
    source: z.number(),
    footprint: z.number(),
  }),
  caps: z.object({ published_advisory: z.number(), no_public_repo: z.number() }),
});

const questions = z.object({
  version,
  questions: z.array(z.object({ id: z.string(), text: z.string() })),
});

const thresholds = z.object({
  version,
  calibrated: z.boolean(),
  questions: z.record(z.string(), z.number()),
});

const proseScreen = z.object({ version, prose_screen: z.enum(["static-only"]) });

export type StaticRules = z.infer<typeof staticRules>;
export type StaticRule = StaticRules["rules"][number];
export type VerdictClass = StaticRule["class"];

export interface RulesVersion {
  readonly version: string;
  readonly proseScreen: z.infer<typeof proseScreen>["prose_screen"];
  readonly staticRules: StaticRules;
  readonly score: z.infer<typeof score>;
  readonly questions: z.infer<typeof questions>;
  readonly thresholds: z.infer<typeof thresholds>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function build(expected: string, raw: Record<string, unknown>): RulesVersion {
  const parsed = {
    staticRules: staticRules.parse(raw.staticRules),
    score: score.parse(raw.score),
    questions: questions.parse(raw.questions),
    thresholds: thresholds.parse(raw.thresholds),
    proseScreen: proseScreen.parse(raw.proseScreen),
  };
  for (const file of Object.values(parsed)) {
    if (file.version !== expected) throw new Error(`rules ${expected}: a file carries version ${file.version}`);
  }
  return deepFreeze({
    version: expected,
    proseScreen: parsed.proseScreen.prose_screen,
    staticRules: parsed.staticRules,
    score: parsed.score,
    questions: parsed.questions,
    thresholds: parsed.thresholds,
  });
}

// A new version is a new directory plus one entry here; nothing else changes.
const sources: Record<string, Record<string, unknown>> = {
  "2026.10.1": {
    staticRules: staticRulesJson,
    score: scoreJson,
    questions: questionsJson,
    thresholds: thresholdsJson,
    proseScreen: proseScreenJson,
  },
};

export const RULES_VERSIONS: readonly string[] = Object.freeze(Object.keys(sources));

const loaded = new Map<string, RulesVersion>();

export function loadRules(wanted: string): RulesVersion {
  const cached = loaded.get(wanted);
  if (cached) return cached;
  const raw = sources[wanted];
  if (!raw) throw new Error(`unknown rules version ${wanted}`);
  const built = build(wanted, raw);
  loaded.set(wanted, built);
  return built;
}

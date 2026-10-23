import { expect } from "vitest";
import type { InvocationView } from "./recorder";
import { Held, Ignored, NotFound, Refusal, type InboxLike, type Observation, type RefusalReason } from "./outcomes";

type Pass = { pass: boolean; message: () => string };
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x), 0) ?? String(v);

/** A matcher works on a value or on a promise of one; a refusal thrown as a rejection counts as a refusal value. */
async function settle(received: unknown): Promise<unknown> {
  if (typeof (received as { then?: unknown } | null)?.then !== "function") return received;
  try {
    return await (received as Promise<unknown>);
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
}

function refusedWith(value: unknown, reason?: RefusalReason): Pass {
  const pass = value instanceof Refusal && (reason === undefined || value.reason === reason);
  return { pass, message: () => `expected a refusal${reason ? ` (${reason})` : ""}, got ${show(value)}` };
}

const matchesAll = (actual: unknown, wanted: Record<string, unknown>, equals: (a: unknown, b: unknown) => boolean) =>
  Object.entries(wanted).every(([k, v]) => equals((actual as Record<string, unknown> | undefined)?.[k], v));

expect.extend({
  async toBeNotFound(received: unknown): Promise<Pass> {
    const value = await settle(received);
    return { pass: value instanceof NotFound, message: () => `expected the shape of a nonexistent resource, got ${show(value)}` };
  },
  async toBeRefused(received: unknown, reason?: RefusalReason): Promise<Pass> {
    return refusedWith(await settle(received), reason);
  },
  async toBeRefusedSaying(received: unknown, text: string): Promise<Pass> {
    const value = await settle(received);
    const message = value instanceof Refusal ? (value.detail.message ?? "") : "";
    const pass = value instanceof Refusal && message.toLowerCase().includes(text.toLowerCase());
    return { pass, message: () => `expected a refusal saying "${text}", got ${show(value)}` };
  },
  async toBeRefusedWithClaimDiff(received: unknown, claims: Record<string, unknown>): Promise<Pass> {
    const value = await settle(received);
    const diff = value instanceof Refusal ? value.detail.claimDiff : undefined;
    const pass = diff !== undefined && Object.entries(claims).every(([k, v]) => k in diff && this.equals(diff[k]?.expected, v));
    return { pass, message: () => `expected a refusal naming the mismatched claims ${Object.keys(claims).join(", ")}, got ${show(value)}` };
  },
  async toBeIgnored(received: unknown): Promise<Pass> {
    const value = await settle(received);
    return { pass: value instanceof Ignored, message: () => `expected the delivery to be acknowledged and ignored, got ${show(value)}` };
  },
  async toBeHeld(received: unknown, reason?: string): Promise<Pass> {
    const value = await settle(received);
    const pass = value instanceof Held && (reason === undefined || value.reason === reason);
    return { pass, message: () => `expected a download held for quarantine${reason ? ` (${reason})` : ""}, got ${show(value)}` };
  },
  async toBeRateLimited(received: unknown): Promise<Pass> {
    return refusedWith(await settle(received), "rate-limited");
  },
  async toRequireHumanCheck(received: unknown): Promise<Pass> {
    return refusedWith(await settle(received), "human-check");
  },
  async toBePack(received: unknown, pack: { name: string }): Promise<Pass> {
    const value = await settle(received);
    return { pass: (value as { name?: string } | null)?.name === pack.name, message: () => `expected a card for ${pack.name}, got ${show(value)}` };
  },
  async toContainPack(received: unknown, pack: { name: string }): Promise<Pass> {
    const value = (await settle(received)) as Array<{ name: string }> | { packs?: Array<{ name: string }> };
    const list = Array.isArray(value) ? value : (value.packs ?? []);
    return { pass: list.some((p) => p.name === pack.name), message: () => `expected the result to list ${pack.name}, got ${show(list.map((p) => p.name))}` };
  },
  async toContainVersion(received: unknown, pack: { name: string }, version: string): Promise<Pass> {
    const value = (await settle(received)) as { versions?: Array<{ pack?: string; name?: string; version: string }> } | Array<{ name?: string; version: string }>;
    const list = Array.isArray(value) ? value : (value.versions ?? []);
    const pass = list.some((v) => v.version === version && ((v as { pack?: string }).pack ?? v.name) === pack.name);
    return { pass, message: () => `expected the result to list ${pack.name}@${version}, got ${show(list)}` };
  },
  async toVerifyAgainst(received: unknown, key: unknown): Promise<Pass> {
    const value = (await settle(received)) as { verifies?: (key: unknown) => Promise<boolean> | boolean };
    const pass = typeof value?.verifies === "function" && (await value.verifies(key));
    return { pass, message: () => "expected the signature to verify against the registry key" };
  },
  async toHaveValidSignature(received: unknown): Promise<Pass> {
    const value = (await settle(received)) as { hasValidSignature?: () => Promise<boolean> | boolean };
    const pass = typeof value?.hasValidSignature === "function" && (await value.hasValidSignature());
    return { pass, message: () => "expected a valid signature" };
  },
  async toLookTheSameAs(received: unknown, other: unknown): Promise<Pass> {
    const [a, b] = (await Promise.all([settle(received), settle(other)])) as [Observation, Observation];
    const pass = this.equals(a?.status, b?.status) && this.equals(a?.headers, b?.headers) && this.equals(a?.body, b?.body);
    return { pass, message: () => `expected identical observations, got ${show(a)} and ${show(b)}` };
  },
  async toBeLive(received: unknown): Promise<Pass> {
    const value = (await settle(received)) as { live?: () => Promise<boolean> | boolean };
    const pass = typeof value?.live === "function" && (await value.live());
    return { pass, message: () => "expected the version to be promoted, downloadable and in the index" };
  },
  async toHaveProvenance(received: unknown, wanted: { repo: string; ref: string; commit?: string }): Promise<Pass> {
    const value = (await settle(received)) as { provenance?: () => Promise<Record<string, unknown>> | Record<string, unknown> };
    const actual = typeof value?.provenance === "function" ? await value.provenance() : undefined;
    return { pass: actual !== undefined && matchesAll(actual, wanted, this.equals), message: () => `expected provenance ${show(wanted)}, got ${show(actual)}` };
  },
  async toBeRefusedForVerification(received: unknown): Promise<Pass> {
    const value = await settle(received);
    return { pass: value instanceof Refusal && value.reason === "signature", message: () => `expected cn to refuse for verification, got ${show(value)}` };
  },
  async toContainEmail(received: unknown, wanted: { about: string }): Promise<Pass> {
    const inbox = (await settle(received)) as InboxLike;
    const about = wanted.about.toLowerCase();
    const pass = inbox.all().some((m) => `${m.subject}\n${m.text}`.toLowerCase().includes(about));
    return { pass, message: () => `expected a mail about "${wanted.about}", inbox holds ${show(inbox.all().map((m) => m.subject))}` };
  },
  async toContainAction(received: unknown, action: string): Promise<Pass> {
    const entries = (await settle(received)) as Array<{ action: string }>;
    return { pass: entries.some((e) => e.action === action), message: () => `expected an audit entry for ${action}, got ${show(entries.map((e) => e.action))}` };
  },
  async toHaveRecorded(received: unknown, signal: string, attrs: Record<string, unknown> = {}): Promise<Pass> {
    const sink = (await settle(received)) as { recorded(): Promise<Array<{ name: string; attrs: Record<string, unknown> }>> };
    const seen = await sink.recorded();
    const pass = seen.some((s) => s.name === signal && matchesAll(s.attrs, attrs, this.equals));
    return { pass, message: () => `expected signal ${signal} ${show(attrs)}, sink saw ${show(seen.map((s) => s.name))}` };
  },
  async toHaveBeenAskedBefore(received: unknown, event: { at: number }): Promise<Pass> {
    const calls = (await settle(received)) as Array<{ at: number }>;
    return { pass: calls.length > 0 && calls.every((c) => c.at < event.at), message: () => `expected every call before the event, got ${show(calls)}` };
  },
  async toHaveBeenAsked(received: unknown): Promise<Pass> {
    const calls = (await settle(received)) as unknown[];
    return { pass: calls.length > 0, message: () => "expected the fake to have been asked" };
  },
  async toHaveAttemptedNoEgress(received: unknown): Promise<Pass> {
    const calls = (await settle(received)) as Array<{ egress_attempts?: string[] }>;
    const attempts = calls.flatMap((c) => c.egress_attempts ?? []);
    return { pass: calls.length > 0 && attempts.length === 0, message: () => (calls.length === 0 ? "the sandbox never ran, so it proves no absence of egress" : `expected no egress attempts, the sandbox recorded ${show(attempts)}`) };
  },
});

/** A field inside `toMatchObject` on a recorded invocation: the Recorder's placeholder for that data class. */
const redacted = (cls: "personal" | "customer-content" | "secret") => {
  const pattern = cls === "secret" ? /^<secret:/ : new RegExp(`^<redacted:${cls}:`);
  return expect.stringMatching(pattern);
};
Object.assign(expect, { redacted });

type Matchers<R> = {
  toBeNotFound(): R;
  toBeRefused(reason?: RefusalReason): R;
  toBeRefusedSaying(text: string): R;
  toBeRefusedWithClaimDiff(claims: Record<string, unknown>): R;
  toBeIgnored(): R;
  toBeHeld(reason?: string): R;
  toBeRateLimited(): R;
  toRequireHumanCheck(): R;
  toBePack(pack: { name: string }): R;
  toContainPack(pack: { name: string }): R;
  toContainVersion(pack: { name: string }, version: string): R;
  toVerifyAgainst(key: unknown): R;
  toHaveValidSignature(): R;
  toLookTheSameAs(other: unknown): R;
  toBeLive(): R;
  toHaveProvenance(wanted: { repo: string; ref: string; commit?: string }): R;
  toBeRefusedForVerification(): R;
  toContainEmail(wanted: { about: string }): R;
  toContainAction(action: string): R;
  toHaveRecorded(signal: string, attrs?: Record<string, unknown>): R;
  toHaveBeenAskedBefore(event: { at: number }): R;
  toHaveBeenAsked(): R;
  toHaveAttemptedNoEgress(): R;
};

declare module "vitest" {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> extends Matchers<R> {
    readonly __received?: T;
  }
  interface AsymmetricMatchersContaining {
    redacted(cls: "personal" | "customer-content" | "secret"): unknown;
  }
}

export type { InvocationView };

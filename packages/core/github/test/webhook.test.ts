import { describe, expect, it } from "vitest";
import { handleWebhook, signWebhookBody, verifyWebhookSignature, type GithubStore, type InstallationStatus, type WebhookRequest } from "../index.ts";

const SECRET = "unit-secret";
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

class MemoryStore implements GithubStore {
  deliveries = new Set<string>();
  bodies = new Set<string>();
  installations = new Map<number, InstallationStatus>();
  issues = new Map<string, string>();
  async hasDelivery(id: string, body: string) {
    return this.deliveries.has(id) || this.bodies.has(body);
  }
  async installationStatus(id: number) {
    return this.installations.get(id) ?? null;
  }
  async recordInstallation(fact: { installationId: number }) {
    this.installations.set(fact.installationId, "active");
  }
  async setInstallationStatus(id: number, status: InstallationStatus) {
    this.installations.set(id, status);
  }
  async setRepositorySelection() {}
  async recordIssue(fact: { repositoryId: number; number: number; state: string }) {
    this.issues.set(`${fact.repositoryId}#${fact.number}`, fact.state);
  }
  async recordDelivery(id: string, _event: string, body: string) {
    this.deliveries.add(id);
    this.bodies.add(body);
  }
}

const installation = (action: string, id = 7) => ({
  action,
  installation: { id, app_id: 42, account: { id: 1, login: "acme", type: "Organization" }, repository_selection: "all" },
  sender: { login: "g" },
});
const issue = (state: "open" | "closed", extra: object = {}) => ({
  action: state === "closed" ? "closed" : "opened",
  installation: { id: 7 },
  issue: { number: 3, state, html_url: "https://github.com/acme/packs/issues/3", updated_at: "2026-10-23T00:00:00Z" },
  repository: { id: 501, full_name: "acme/packs", private: false },
  ...extra,
});

async function delivery(event: string, payload: unknown, over: Partial<WebhookRequest> = {}): Promise<WebhookRequest> {
  const body = enc(payload);
  return { event, deliveryId: `d-${Math.random()}`, signature: await signWebhookBody(SECRET, body), body, ...over };
}
const run = (store: GithubStore, request: WebhookRequest) => handleWebhook({ secret: SECRET, appId: "42", store, now: () => "2026-10-23T00:00:00Z" }, request);

describe("signature (IT-PUB-028)", () => {
  it("accepts the right MAC and refuses a wrong, missing, malformed or empty-secret one", async () => {
    const body = enc({ a: 1 });
    const good = await signWebhookBody(SECRET, body);
    expect(await verifyWebhookSignature(SECRET, body, good)).toBe(true);
    expect(await verifyWebhookSignature(SECRET, body, await signWebhookBody("other", body))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, null)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, good.toUpperCase())).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, good.slice(0, -2))).toBe(false);
    expect(await verifyWebhookSignature("", body, good)).toBe(false);
  });

  it("reads nothing of the payload before the signature holds", async () => {
    const store = new MemoryStore();
    const body = new TextEncoder().encode("{not json");
    expect(await run(store, { event: "installation", deliveryId: "x", signature: "sha256=" + "0".repeat(64), body })).toEqual({ result: "ignored" });
    expect(await run(store, { event: "installation", deliveryId: "x", signature: await signWebhookBody(SECRET, body), body })).toEqual({ result: "malformed" });
  });
});

describe("delivery handling", () => {
  it("registers an installation, then applies later events only for a known one", async () => {
    const store = new MemoryStore();
    expect((await run(store, await delivery("installation", installation("deleted", 99)))).result).toBe("ignored");
    expect((await run(store, await delivery("installation", installation("created")))).result).toBe("applied");
    expect(store.installations.get(7)).toBe("active");
    expect((await run(store, await delivery("installation", installation("suspend")))).result).toBe("applied");
    expect(store.installations.get(7)).toBe("suspended");
    expect((await run(store, await delivery("installation", installation("deleted")))).result).toBe("applied");
    expect(store.installations.get(7)).toBe("deleted");
    expect((await run(store, await delivery("issues", issue("closed")))).result).toBe("ignored");
  });

  it("records the state of a public repository's issue and leaves a private one alone", async () => {
    const store = new MemoryStore();
    await run(store, await delivery("installation", installation("created")));
    await run(store, await delivery("issues", issue("closed")));
    expect(store.issues.get("501#3")).toBe("closed");
    await run(store, await delivery("issues", issue("open", { repository: { id: 9, full_name: "acme/secret", private: true } })));
    expect([...store.issues.keys()]).toEqual(["501#3"]);
  });

  it("ignores an installation created for another App", async () => {
    const store = new MemoryStore();
    const foreign = installation("created");
    foreign.installation.app_id = 43;
    expect((await run(store, await delivery("installation", foreign))).result).toBe("ignored");
    expect(store.installations.size).toBe(0);
  });

  it("applies a delivery id once", async () => {
    const store = new MemoryStore();
    const first = await delivery("installation", installation("created"), { deliveryId: "same" });
    expect((await run(store, first)).result).toBe("applied");
    expect((await run(store, first)).result).toBe("duplicate");
  });

  it("drops a replayed body under a new delivery id", async () => {
    const store = new MemoryStore();
    const first = await delivery("installation", installation("created"));
    expect((await run(store, first)).result).toBe("applied");
    expect((await run(store, { ...first, deliveryId: "fresh-id" })).result).toBe("duplicate");
  });

  it("does not subscribe to push or anything else", async () => {
    const store = new MemoryStore();
    expect((await run(store, await delivery("push", { ref: "refs/heads/main" }))).result).toBe("unsubscribed");
    expect((await run(store, await delivery("ping", { zen: "x" }))).result).toBe("unsubscribed");
  });

  it("calls a body that is not the documented shape malformed", async () => {
    const store = new MemoryStore();
    expect((await run(store, await delivery("installation", { action: "created" }))).result).toBe("malformed");
    expect((await run(store, await delivery("issues", issue("open"), { deliveryId: null }))).result).toBe("malformed");
  });
});

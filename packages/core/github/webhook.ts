import { isSubscribedEvent, parseEvent, type GithubFact } from "./events.ts";
import { verifyWebhookSignature } from "./signature.ts";

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type InstallationStatus = "active" | "suspended" | "deleted";

/** What the webhook handler needs to remember; the Worker backs it with D1. */
export interface GithubStore {
  hasDelivery(deliveryId: string, bodySha256: string): Promise<boolean>;
  installationStatus(installationId: number): Promise<InstallationStatus | null>;
  recordInstallation(fact: Extract<GithubFact, { kind: "installation" }>, now: string): Promise<void>;
  setInstallationStatus(installationId: number, status: InstallationStatus, now: string): Promise<void>;
  setRepositorySelection(installationId: number, selection: "all" | "selected", now: string): Promise<void>;
  recordIssue(fact: Extract<GithubFact, { kind: "issue" }>, now: string): Promise<void>;
  recordDelivery(deliveryId: string, event: string, bodySha256: string, now: string): Promise<void>;
}

export interface WebhookRequest {
  event: string | null;
  deliveryId: string | null;
  signature: string | null;
  body: Uint8Array<ArrayBuffer>;
}

/**
 * `ignored` covers a bad signature and an unknown installation alike, so the caller answers both
 * the same way and nothing tells a prober which check failed (REQ-PUB-028).
 */
export type WebhookOutcome =
  | { result: "ignored" }
  | { result: "malformed" }
  | { result: "unsubscribed" }
  | { result: "duplicate" }
  | { result: "applied"; fact: GithubFact };

const INSTALLATION_STATUS: Record<string, InstallationStatus | undefined> = {
  deleted: "deleted",
  suspend: "suspended",
  unsuspend: "active",
};

export async function handleWebhook(
  deps: { secret: string; appId: string; store: GithubStore; now: () => string },
  request: WebhookRequest,
): Promise<WebhookOutcome> {
  // The signature is checked over the raw bytes before anything reads the payload.
  if (!(await verifyWebhookSignature(deps.secret, request.body, request.signature))) return { result: "ignored" };
  if (!request.deliveryId || !request.event) return { result: "malformed" };
  if (!isSubscribedEvent(request.event)) return { result: "unsubscribed" };

  let fact: GithubFact;
  try {
    fact = parseEvent(request.event, JSON.parse(new TextDecoder().decode(request.body)));
  } catch {
    return { result: "malformed" };
  }
  const bodySha256 = await sha256Hex(request.body);
  if (await deps.store.hasDelivery(request.deliveryId, bodySha256)) return { result: "duplicate" };

  // `installation.created` is how the registry first hears of an installation, so it must name this App;
  // every other event needs an installation the registry already knows.
  const creating = fact.kind === "installation" && fact.action === "created" ? fact : null;
  if (creating) {
    if (String(creating.appId) !== deps.appId) return { result: "ignored" };
  } else {
    if (fact.installationId === null) return { result: "ignored" };
    const status = await deps.store.installationStatus(fact.installationId);
    if (status === null || status === "deleted") return { result: "ignored" };
  }

  const now = deps.now();
  if (fact.kind === "installation") {
    const status = INSTALLATION_STATUS[fact.action];
    if (creating) await deps.store.recordInstallation(creating, now);
    else if (status) await deps.store.setInstallationStatus(fact.installationId, status, now);
    else await deps.store.setRepositorySelection(fact.installationId, fact.repositorySelection, now);
  } else if (fact.kind === "repositories") {
    await deps.store.setRepositorySelection(fact.installationId, fact.repositorySelection, now);
  } else if (!fact.repositoryPrivate) {
    await deps.store.recordIssue(fact, now);
  }
  await deps.store.recordDelivery(request.deliveryId, request.event, bodySha256, now);
  return { result: "applied", fact };
}

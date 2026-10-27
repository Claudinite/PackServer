import type { ApiResponse, Driver } from "../../drivers/driver";
import type { Aliases } from "../alias";
import type { CiModule } from "../ci-workflow";
import { InfrastructureError } from "../errors";
import { NotFound, Refusal } from "../outcomes";
import type { ArchiveHandle } from "../publishing";
import type { Sensitive, User } from "../types";
import { callerOf } from "./users";

/** The publish wizard's page as its publisher reads it. */
export interface WizardPageView {
  /** The page's visible words, hidden steps included: the script shows one step at a time. */
  text: string;
  /** What the page opened with: the person's scopes, the preselected pack, its waiting draft and the attempt to retry. */
  state: {
    scopes: string[];
    pack: { full: string; exists: boolean; visibility: "public" | "private" | null } | null;
    draft: { version: string; credentialId: string; sizeBytes: number | null; expired: boolean } | null;
    lastRun: { id: string; version: string; verdict: string | null } | null;
    categories: string[];
    maxBytes: number;
  };
}

/** A run as the wizard shows it. */
export interface WizardRun {
  id: string;
  status: "queued" | "running" | "finished";
  verdict: "pass" | "warn" | "hold" | "fail" | "error" | null;
  /** The one sentence the wizard puts first. */
  sentence: string;
  approval: "awaiting" | "approved" | null;
  published: boolean;
  steps: string[];
  findings: Array<{ class: string; rule: string; file: string | null; line: number | null; hint: string }>;
}

export interface WizardUploadOpts {
  /** The check step's object, staged under the dry-run prefix; otherwise the draft that outlives it. */
  dryRun?: boolean;
  /** The upload stops after the URL is issued and signed: the browser never sent the bytes. */
  stopBeforePut?: boolean;
}

export interface WizardUpload {
  credentialId: string;
  key: string;
  /** False when the upload stopped before the PUT. */
  stored: boolean;
}

export interface WizardModule {
  wizard: {
    /** Fills the engine mirror a validation run reads, as a release workflow does; the verbs below do it themselves, a browser does not. */
    prepare(): Promise<void>;
    page(by: User, pack?: string): Promise<WizardPageView | NotFound | { kind: "sign-in"; next: string }>;
    upload(by: User, archive: ArchiveHandle, nameAtVersion: string, o?: WizardUploadOpts): Promise<WizardUpload>;
    /** The final step: a draft upload, then the start confirmed with the person's passkey, followed to its verdict. */
    publish(by: User, archive: ArchiveHandle, nameAtVersion: string, o?: Sensitive & { draft?: WizardUpload }): Promise<WizardRun>;
  };
}

const NAME_AT_VERSION = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const words = (html: string): string => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createWizard(driver: Driver, aliases: Aliases, ci: CiModule, ensureEngines: () => Promise<void>): WizardModule {
  const parse = (nameAtVersion: string) => {
    const m = NAME_AT_VERSION.exec(nameAtVersion);
    if (!m) throw new InfrastructureError(`not a pack at a version: ${nameAtVersion}`);
    return { pack: `@${aliases.alias(m[1]!)}/${m[2]!}`, version: m[3]! };
  };

  const systemPack = (pack: string): string => {
    const [scope, name] = pack.replace(/^@/, "").split("/") as [string, string];
    return `@${aliases.alias(scope)}/${name}`;
  };

  const refused = (res: ApiResponse, what: string): Refusal => {
    let body: { reason?: Refusal["reason"]; message?: string; retry_after_s?: number } = {};
    try {
      body = res.json() as typeof body;
    } catch {
      /* reported below */
    }
    if (!body.reason) throw new InfrastructureError(`${what}: expected a refusal, got ${res.status} ${res.text.slice(0, 200)}`);
    return new Refusal(body.reason, { ...(body.message === undefined ? {} : { message: body.message }), ...(body.retry_after_s === undefined ? {} : { retryAfterS: body.retry_after_s }) });
  };

  const publishSurface = (method: "POST", path: string, bearer: string, body: unknown) =>
    driver.http.request({ surface: "publish", method, path, headers: { authorization: `Bearer ${bearer}` }, body });

  async function upload(by: User, archive: ArchiveHandle, nameAtVersion: string, o: WizardUploadOpts = {}): Promise<WizardUpload> {
    const target = parse(nameAtVersion);
    const granted = await callerOf(by).call({ method: "POST", path: "/publish/wizard/upload", json: { ...target, ...(o.dryRun ? { dry_run: true } : {}) } });
    if (granted.status !== 200) throw refused(granted, "wizard upload");
    const grant = granted.json() as { credential: string; presign_path: string };
    const presigned = await publishSurface("POST", grant.presign_path, grant.credential, { content_length: archive.bytes.byteLength });
    if (presigned.status !== 200) throw refused(presigned, "presign");
    const p = presigned.json() as { url: string; key: string; headers: Record<string, string>; credential_id: string };
    if (o.stopBeforePut) return { credentialId: p.credential_id, key: p.key, stored: false };
    const stored = await ci.ci.put({ url: p.url, key: p.key, headers: p.headers, credentialId: p.credential_id }, archive.bytes);
    if (stored instanceof Refusal) throw stored;
    const done = await publishSurface("POST", grant.presign_path.replace(/\/upload-url$/, "/uploaded"), grant.credential, {});
    if (done.status !== 200) throw refused(done, "uploaded");
    return { credentialId: p.credential_id, key: p.key, stored: true };
  }

  async function follow(by: User, id: string, timeoutMs = 90_000): Promise<WizardRun> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await callerOf(by).call({ method: "GET", path: `/publish/wizard/runs/${id}` });
      if (res.status !== 200) throw new InfrastructureError(`reading run ${id} through the wizard answered ${res.status}: ${res.text.slice(0, 200)}`);
      const run = res.json() as WizardRun & { milestones: Array<{ step: string; outcome: string }> };
      if (run.status === "finished") return { ...run, steps: run.milestones.map((m) => `${m.step} ${m.outcome}`) };
      if (Date.now() > deadline) throw new InfrastructureError(`run ${id} did not finish in ${timeoutMs} ms through the wizard`);
      await sleep(100);
    }
  }

  return {
    wizard: {
      prepare: ensureEngines,
      async page(by, pack) {
        const res = await callerOf(by).call({ method: "GET", path: pack === undefined ? "/publish" : `/publish?pack=${encodeURIComponent(systemPack(pack))}` });
        if (res.status === 303) return { kind: "sign-in", next: new URL(res.headers.get("location") ?? "", "https://site.invalid").searchParams.get("next") ?? "" };
        if (res.status === 404) return new NotFound();
        if (res.status !== 200) throw new InfrastructureError(`the wizard page answered ${res.status}`);
        const state = /<script type="application\/json" id="wiz-state">([\s\S]*?)<\/script>/.exec(res.text)?.[1];
        if (!state) throw new InfrastructureError("the wizard page carries no state");
        return { text: aliases.unalias(words(res.text)), state: JSON.parse(state) as WizardPageView["state"] };
      },
      upload,
      async publish(by, archive, nameAtVersion, o = {}) {
        await ensureEngines();
        const target = parse(nameAtVersion);
        const staged = o.draft ?? (await upload(by, archive, nameAtVersion));
        const headers = await callerOf(by).assertionHeaders("publish.start", o, `${target.pack}@${target.version}`);
        const started = await callerOf(by).call({ method: "POST", path: "/publish/wizard/start", json: { ...target, sha256: archive.sha256, credential_id: staged.credentialId }, headers });
        if (started.status >= 400) throw refused(started, "wizard start");
        return follow(by, (started.json() as { run_id: string }).run_id);
      },
    },
  };
}

import type { Driver } from "../../drivers/driver";
import { GITHUB_TEST_APP_ID, type FakeFile, type FakeRepo, type RecordedRequest } from "../../fakes/github-app";
import { InfrastructureError } from "../errors";
import { Ignored } from "../outcomes";

export interface GitHubRepoHandle {
  readonly id: number;
  readonly slug: string;
  /** A commit holding exactly these files; returns its sha. */
  commit(files: Record<string, string | FakeFile>): string;
}

export interface GitHubInstallation {
  readonly id: number;
  readonly account: string;
}

/** A delivery the registry acknowledged: what it did with it. */
export interface Delivered {
  status: number;
  result: "applied" | "duplicate" | "unsubscribed";
}

/** A delivery the registry ignored; it answers every ignored delivery the same way, whichever check failed. */
export class IgnoredDelivery extends Ignored {
  constructor(
    readonly status: number,
    readonly text: string,
  ) {
    super();
  }
}

export interface WebhookOptions {
  /** The raw payload; by default a well-formed one for `event`, for an installation the App already holds. */
  payload?: object;
  signature?: "wrong" | "missing";
  /** `unknown` sends the event from an installation, and an App, the registry has never been told about. */
  installation?: "unknown" | number;
  deliveryId?: string;
}

export interface InstallOptions {
  /** The GitHub login of the person who installs; defaults to the account itself. */
  by?: string;
  type?: "Organization" | "User";
  installationId?: number;
  repositories?: "all" | "selected";
}

export interface IssueStateOptions {
  installationId?: number;
  private?: boolean;
  updatedAt?: string;
  deliveryId?: string;
}

export interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_type: string;
  sender_login: string;
  repository_selection: string;
  status: "active" | "suspended" | "deleted";
  installed_at: string;
  uninstalled_at: string | null;
}

export interface IssueRow {
  repository: string;
  html_url: string;
  state: "open" | "closed" | "deleted";
}

/** The faked GitHub: accounts, repos, webhooks and the proof that PackServer never writes. */
export interface GitHubModule {
  github: {
    /** Every request that would change something on GitHub; a scenario that must not write asserts it is `[]`. */
    writes(): Promise<RecordedRequest[]>;
    /** Every request the registry made to GitHub's API. */
    apiCalls(): RecordedRequest[];
    tokensMinted(): number;
    /** Makes GitHub answer every API call with this status until `null`. */
    failApi(status: number | null): void;
    repo(slug: string, o?: { id?: number; private?: boolean }): GitHubRepoHandle;
    installApp(account: string, o?: InstallOptions): Promise<GitHubInstallation>;
    uninstallApp(installation: GitHubInstallation): Promise<Delivered | IgnoredDelivery>;
    /** Delivers the `issues` webhook GitHub sends when this issue changes state. */
    issueState(repo: string, number: number, state: "open" | "closed", o?: IssueStateOptions): Promise<Delivered | IgnoredDelivery>;
    webhook(event: string, o?: WebhookOptions): Promise<Delivered | IgnoredDelivery>;
    installation(id: number): Promise<InstallationRow | null>;
    issue(repo: string, number: number): Promise<IssueRow | null>;
    /** What the validator asks the `github` Worker for. */
    fetchTree(o: { repository: string | GitHubRepoHandle; commit: string; path: string }): Promise<TreeFetchResponse>;
  };
}

/** The `github` Worker's answer to a tree request (the `TreeFetchResponse` contract). */
export type TreeFetchResponse =
  | { status: "found"; tree_hash: string; file_count: number }
  | { status: "not_found" }
  | { status: "unreachable"; retry_after_s?: number };

const FOREIGN_APP_ID = 777;
const UNKNOWN_INSTALLATION = 99_999;

export function createGitHub(driver: Driver): GitHubModule {
  const app = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fake GitHub`);
    return driver.fakes.githubApp;
  };
  type Reader = { prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results: unknown[] }> } } };
  const query = async (sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> => {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver cannot read stored state`);
    const db = (await driver.storage()).db as unknown as Reader;
    return (await db.prepare(sql).bind(...params).all()).results as Array<Record<string, unknown>>;
  };
  let installations = 100;

  const account = (login: string, type: "Organization" | "User" = "Organization") => ({ login, id: 1000 + login.length, type });
  const installationPayload = (action: string, id: number, login: string, o: InstallOptions & { appId?: number } = {}) => ({
    action,
    installation: {
      id,
      app_id: o.appId ?? Number(GITHUB_TEST_APP_ID),
      account: account(login, o.type),
      repository_selection: o.repositories ?? "all",
    },
    sender: { login: o.by ?? login },
  });
  const defaultPayload = (event: string, o: WebhookOptions): object => {
    const unknown = o.installation === "unknown";
    const id = typeof o.installation === "number" ? o.installation : unknown ? UNKNOWN_INSTALLATION : 101;
    if (event === "installation") return installationPayload("created", id, "acme", unknown ? { appId: FOREIGN_APP_ID } : {});
    if (event === "installation_repositories") return { action: "added", installation: { id }, repository_selection: "selected" };
    if (event === "issues") {
      return {
        action: "closed",
        installation: { id },
        issue: { number: 1, state: "closed", html_url: "https://github.com/acme/packs/issues/1", updated_at: "2026-10-23T00:00:00Z" },
        repository: { id: 501, full_name: "acme/packs", private: false },
      };
    }
    return { zen: "irrelevant" };
  };

  const deliver = async (event: string, payload: object, o: Pick<WebhookOptions, "signature" | "deliveryId"> = {}): Promise<Delivered | IgnoredDelivery> => {
    const { headers, body } = app().delivery(event, payload, o);
    const res = await driver.http.request({ surface: "github", method: "POST", path: "/hooks/github", headers, body });
    if (res.status === 401) return new IgnoredDelivery(res.status, res.text);
    if (res.status !== 200) throw new InfrastructureError(`the github Worker answered a webhook with ${res.status}: ${res.text}`);
    return { status: res.status, result: (res.json() as { result: Delivered["result"] }).result };
  };

  const repoHandle = (repo: FakeRepo): GitHubRepoHandle => ({
    id: repo.id,
    slug: repo.slug,
    commit: (files) => app().commit(repo, files),
  });

  return {
    github: {
      async writes() {
        const signIn = driver.fakes?.githubLogin.writes() ?? [];
        return [...app().writes, ...signIn.map(({ method, path }) => ({ method, path }))];
      },
      apiCalls: () => [...app().requests],
      tokensMinted: () => app().tokensMinted,
      failApi(status) {
        app().failWith = status ?? undefined;
      },
      repo: (slug, o) => repoHandle(app().repo(slug, o)),
      async installApp(login, o = {}) {
        const id = o.installationId ?? ++installations;
        const delivered = await deliver("installation", installationPayload("created", id, login, o));
        if (delivered instanceof Ignored || delivered.result !== "applied") throw new InfrastructureError(`the installation of ${login} was not applied`);
        return { id, account: login };
      },
      uninstallApp: (installation) => deliver("installation", installationPayload("deleted", installation.id, installation.account)),
      issueState(repo, number, issueState, o = {}) {
        const handle = app().repo(repo, o.private === undefined ? {} : { private: o.private });
        return deliver(
          "issues",
          {
            action: issueState,
            installation: { id: o.installationId ?? 101 },
            issue: { number, state: issueState, html_url: `https://github.com/${repo}/issues/${number}`, updated_at: o.updatedAt ?? "2026-10-23T00:00:00Z" },
            repository: { id: handle.id, full_name: repo, private: handle.private },
          },
          o.deliveryId === undefined ? {} : { deliveryId: o.deliveryId },
        );
      },
      webhook: (event, o = {}) => deliver(event, o.payload ?? defaultPayload(event, o), { ...(o.signature ? { signature: o.signature } : {}), ...(o.deliveryId ? { deliveryId: o.deliveryId } : {}) }),
      async installation(id) {
        const rows = await query("select * from github_installations where installation_id = ?", [id]);
        return (rows[0] as unknown as InstallationRow | undefined) ?? null;
      },
      async issue(repo, number) {
        const rows = await query("select repository, html_url, state from github_issue_states where repository = ? and issue_number = ?", [repo, number]);
        return (rows[0] as unknown as IssueRow | undefined) ?? null;
      },
      async fetchTree({ repository, commit, path }) {
        const repo = typeof repository === "string" ? app().repo(repository) : repository;
        const res = await driver.http.request({
          surface: "github",
          method: "POST",
          path: "/internal/tree",
          headers: { "content-type": "application/json" },
          body: { repository_id: repo.id, commit, path },
        });
        if (res.status !== 200) throw new InfrastructureError(`the github Worker answered a tree request with ${res.status}: ${res.text}`);
        return res.json() as TreeFetchResponse;
      },
    },
  };
}

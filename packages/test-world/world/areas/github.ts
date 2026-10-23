import { stubModule } from "../errors";

/** The faked GitHub: accounts, repos, webhooks and the proof that PackServer never writes. */
export interface GitHubModule {
  github: {
    writes(): Promise<unknown[]>;
    repo(slug: string): unknown;
    webhook(event: string, o?: { signature?: "wrong" | "missing" }): Promise<unknown>;
  };
  dns: { publishTxt(name: string, value: string): void; remove(name: string): void };
}

export const createGitHub = (): GitHubModule => ({ github: stubModule("github"), dns: stubModule("dns") });

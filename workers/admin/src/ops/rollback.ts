import type { RollbackDispatch } from "./context";

export interface GithubRollbackOptions {
  /** `owner/repo`, whose `rollback.yml` is dispatched. */
  repo: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}

const WORKFLOW = "rollback.yml";
/** The workflow runs only from the protected branch, so a dispatch cannot name another ref. */
const REF = "main";

/**
 * The roll-back tap dispatches the repository's own workflow rather than rolling a Worker back itself, so the change
 * goes through the same environment, ref and manifest as any other and nothing here bypasses the branch ruleset (REQ-OPS-013).
 */
export function githubRollback(options: GithubRollbackOptions): RollbackDispatch {
  const send = options.fetch ?? fetch;
  return {
    async dispatch(reason) {
      const response = await send(`https://api.github.com/repos/${options.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await options.token()}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "packserver-admin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: REF, inputs: { reason } }),
      });
      return response.status === 204 ? { ok: true } : { ok: false, status: response.status };
    },
  };
}

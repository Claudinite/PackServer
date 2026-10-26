export const AUDIENCE = "registry.claudinite.com";

export interface RunnerEnv {
  ACTIONS_ID_TOKEN_REQUEST_URL?: string;
  ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
}

/** Asks the runner for this job's OIDC token; it exists only when the job has `id-token: write`. */
export async function requestToken(runner: RunnerEnv, fetchFn: typeof fetch): Promise<string> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = runner;
  if (!url || !bearer) throw new Error("no OIDC token is available: give the job `permissions: id-token: write`");
  const target = new URL(url);
  target.searchParams.set("audience", AUDIENCE);
  const response = await fetchFn(target, { headers: { authorization: `Bearer ${bearer}` } });
  if (!response.ok) throw new Error(`the runner refused the OIDC token request (HTTP ${response.status})`);
  const body = (await response.json()) as { value?: unknown };
  if (typeof body.value !== "string" || body.value === "") throw new Error("the runner's OIDC answer carried no token");
  return body.value;
}

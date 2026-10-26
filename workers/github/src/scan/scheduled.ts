/**
 * What a cron fire does with the scan route's answer. Running out of search allowance or time
 * is how a scan normally proceeds, and the next fire resumes it; only a GitHub that could not
 * be reached is a failure.
 */
export async function expectScanRan(response: Response): Promise<void> {
  const body = (await response.json().catch(() => null)) as { outcome?: string } | null;
  if (!response.ok || body?.outcome === "unreachable") throw new Error(`the weekly scan ended ${body?.outcome ?? response.status}`);
}

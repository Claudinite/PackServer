/**
 * The environment contract of the `http` driver, and the only place the test world reads the
 * process environment: credentials never reach a World or a scenario another way.
 */
export interface HttpEnv {
  baseUrl: URL;
  /** The raw `Cloudflare-Workers-Version-Overrides` value; empty means none. */
  versionOverride: string;
  /** Release ids an answering Worker may report; required whenever an override is set. */
  expectedReleases: ReadonlySet<string> | null;
  access: { clientId: string; clientSecret: string; host: string } | null;
  /** Signs every request, so a candidate that answers only signed ones (release.md §Candidate gating) answers the scenarios. */
  selfTest: { key: string; keyId: string } | null;
  probeTenant: string;
}

export class HttpEnvError extends Error {
  override readonly name = "HttpEnvError";
}

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function readHttpEnv(env: Record<string, string | undefined> = process.env): HttpEnv {
  const base = env.PACKSERVER_BASE_URL?.trim();
  if (!base) throw new HttpEnvError("PACKSERVER_BASE_URL is required by the http driver");
  const baseUrl = new URL(base);
  if (baseUrl.protocol !== "https:" && !LOCAL.test(baseUrl.host)) {
    throw new HttpEnvError(`PACKSERVER_BASE_URL must be https (got ${baseUrl.protocol}//${baseUrl.host})`);
  }
  const versionOverride = env.PACKSERVER_VERSION_OVERRIDE?.trim() ?? "";
  const expected = (env.PACKSERVER_EXPECTED_RELEASE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (versionOverride && expected.length === 0) {
    throw new HttpEnvError("PACKSERVER_VERSION_OVERRIDE is set, so PACKSERVER_EXPECTED_RELEASE must name the release the candidate reports: Cloudflare ignores an invalid override silently");
  }
  const clientId = env.CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET?.trim();
  const accessHost = env.PACKSERVER_ACCESS_HOST?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new HttpEnvError("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET come together");
  if (clientId && !accessHost) throw new HttpEnvError("the Access service token needs PACKSERVER_ACCESS_HOST: it is sent to that host only");
  const selfTestKey = env.SELFTEST_HMAC_KEY?.trim();
  return {
    baseUrl,
    versionOverride,
    expectedReleases: expected.length > 0 ? new Set(expected) : null,
    access: clientId && clientSecret && accessHost ? { clientId, clientSecret, host: accessHost } : null,
    selfTest: selfTestKey ? { key: selfTestKey, keyId: env.SELFTEST_KEY_ID?.trim() || "1" } : null,
    probeTenant: env.PACKSERVER_PROBE_TENANT?.trim() || "@probe",
  };
}

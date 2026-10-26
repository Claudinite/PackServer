import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../root";

export interface PublishTestConfig {
  oidc: { issuer: string; jwksUrl: string };
  s3: { endpoint: string; accessKeyId: string; secretAccessKey: string };
}

/** What the publish Worker's `env.test` trusts, read from its Wrangler config so the fakes and the Worker cannot drift apart. */
export function publishTestConfig(root: string = REPO_ROOT): PublishTestConfig | undefined {
  let vars: Record<string, string> | undefined;
  try {
    vars = (JSON.parse(readFileSync(join(root, "workers/publish/wrangler.jsonc"), "utf8")) as { env?: { test?: { vars?: Record<string, string> } } }).env?.test?.vars;
  } catch {
    return undefined;
  }
  const v = vars ?? {};
  if (!v.OIDC_ISSUER || !v.OIDC_JWKS_URL || !v.STAGING_S3_ENDPOINT || !v.STAGING_S3_ACCESS_KEY_ID || !v.STAGING_S3_SECRET_ACCESS_KEY) return undefined;
  return {
    oidc: { issuer: v.OIDC_ISSUER, jwksUrl: v.OIDC_JWKS_URL },
    s3: { endpoint: v.STAGING_S3_ENDPOINT, accessKeyId: v.STAGING_S3_ACCESS_KEY_ID, secretAccessKey: v.STAGING_S3_SECRET_ACCESS_KEY },
  };
}

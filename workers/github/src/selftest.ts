import { localSelfTestChecks, storeChecks, type SelfTestCheck } from "@packserver/http";
import { appJwt } from "@packserver/core/github";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { GithubRuntime } from "./bindings";

const GITHUB_APP_PROBE = "https://api.github.com/app/installations?per_page=1";

export function selfTestChecks(runtime: GithubRuntime): SelfTestCheck[] {
  const { ports, services } = runtime;
  return [
    ...localSelfTestChecks(runtime),
    ...storeChecks({ d1: ports.d1, kv: ports.kv, schema: { min: SCHEMA_MIN, max: SCHEMA_MAX } }),
    {
      // A read the App's own identity may make; nothing is created and no installation token is minted.
      name: "outbound.github-app",
      run: async () => {
        const [appId, privateKey] = await Promise.all([services.secrets.appId(), services.secrets.privateKey()]);
        const jwt = await appJwt({ appId, privateKey, nowMs: Date.now() });
        const response = await services.fetch(GITHUB_APP_PROBE, { headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "claudinite-packserver-selftest" } });
        return response.ok;
      },
    },
  ];
}

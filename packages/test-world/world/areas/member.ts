import type { Driver } from "../../drivers/driver";
import { InfrastructureError, NotImplemented } from "../errors";
import { Refusal } from "../outcomes";
import type { DeviceGrant, DevicePollResult, DeviceSignIn, DeviceToken, Member, MemberPolicy } from "../types";

/** A repository running the pinned cn. */
export interface MemberModule {
  member(policy?: MemberPolicy): Member;
}

const LAPTOP_ADDRESS = "198.51.100.77";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const POLL_STATUS = {
  authorization_pending: "pending",
  slow_down: "slow-down",
  access_denied: "denied",
  expired_token: "expired",
  invalid_grant: "invalid",
} as const;

class Laptop implements Member {
  constructor(private readonly driver: Driver) {}

  private request(method: string, path: string, headers: Record<string, string>, body?: unknown) {
    return this.driver.http.request({
      surface: "web",
      method,
      path,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async signIn(opts: { from?: string; country?: string } = {}): Promise<DeviceSignIn> {
    const res = await this.request("POST", "/api/auth/device", {
      "cf-connecting-ip": opts.from ?? LAPTOP_ADDRESS,
      ...(opts.country ? { "cf-ipcountry": opts.country } : {}),
    }, { client_id: "cn" });
    if (res.status !== 200) throw new InfrastructureError(`member.signIn: the registry answered ${res.status} to a device code request: ${res.text.slice(0, 120)}`);
    const started = res.json() as { device_code: string; user_code: string; verification_uri: string };
    const from = opts.from ?? LAPTOP_ADDRESS;
    return {
      userCode: started.user_code,
      link: started.verification_uri,
      poll: async (): Promise<DevicePollResult> => {
        const answer = await this.request("POST", "/api/auth/device/token", { "cf-connecting-ip": from }, { grant_type: DEVICE_GRANT, device_code: started.device_code });
        const body = answer.json() as { access_token?: string; expires_in?: number; error?: keyof typeof POLL_STATUS };
        if (answer.status === 200 && body.access_token) {
          return { status: "granted", token: { value: body.access_token, expiresInS: body.expires_in ?? 0 } };
        }
        const status = body.error ? POLL_STATUS[body.error] : undefined;
        if (!status) throw new InfrastructureError(`member.signIn: unexpected poll answer ${answer.status} ${answer.text.slice(0, 120)}`);
        return { status };
      },
    };
  }

  async grantOf(token: DeviceToken): Promise<DeviceGrant | Refusal> {
    const res = await this.request("GET", "/api/auth/device/grant", { authorization: `Bearer ${token.value}`, "cf-connecting-ip": LAPTOP_ADDRESS });
    if (res.status === 401) return new Refusal("signed-out");
    if (res.status !== 200) throw new InfrastructureError(`member.grantOf: the registry answered ${res.status}: ${res.text.slice(0, 120)}`);
    const body = res.json() as { grants: string[]; expires_at: string };
    return { grants: body.grants, expiresAt: new Date(body.expires_at) };
  }

  fetchRoot(): Promise<unknown> {
    throw new NotImplemented("member.fetchRoot");
  }
  fetchIndex(): Promise<unknown> {
    throw new NotImplemented("member.fetchIndex");
  }
  adopt(): Promise<unknown> {
    throw new NotImplemented("member.adopt");
  }
}

export const createMember = (driver: Driver): MemberModule => ({ member: () => new Laptop(driver) });

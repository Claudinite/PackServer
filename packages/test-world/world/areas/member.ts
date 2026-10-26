import { sha256Hex } from "@packserver/core/index";
import { PrivateEntry } from "@packserver/schema";
import type { ApiResponse, Driver } from "../../drivers/driver";
import { InfrastructureError, NotImplemented } from "../errors";
import { Held, NotFound, Refusal, type Observation } from "../outcomes";
import type { ActionsRepo, DeviceGrant, DevicePollResult, DeviceSignIn, DeviceToken, Member, MemberPolicy, PrivateArchive, PrivateIndex, PrivateReads, User } from "../types";

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

/** Where a read gets its credential from, asked afresh for each request. */
type Credential = () => Promise<{ request: (method: string, path: string) => Promise<ApiResponse> }>;

const OBSERVED_HEADERS = ["cache-control", "content-type", "www-authenticate", "content-disposition", "x-content-type-options"];

const observed = (res: ApiResponse): Observation => ({
  status: res.status,
  headers: Object.fromEntries(OBSERVED_HEADERS.flatMap((h) => (res.headers.has(h) ? [[h, res.headers.get(h) as string]] : []))),
  body: (() => {
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      return res.text;
    }
  })(),
});

const indexPath = (pack?: string): string => `/api/private/index${pack === undefined ? "" : `?pack=${encodeURIComponent(pack)}`}`;

/** The private reads of one credential; an archive is read as text, which holds for the world's ASCII archives. */
class Reads implements PrivateReads {
  constructor(private readonly credential: Credential) {}

  private async get(path: string): Promise<ApiResponse> {
    return (await this.credential()).request("GET", path);
  }

  private static outcome(res: ApiResponse, what: string): NotFound | Refusal | undefined {
    if (res.status === 404) return new NotFound();
    if (res.status === 401) return new Refusal("signed-out");
    if (res.status !== 200 && res.status !== 451) throw new InfrastructureError(`${what}: the registry answered ${res.status}: ${res.text.slice(0, 120)}`);
    return undefined;
  }

  async index(opts: { pack?: string } = {}): Promise<PrivateIndex | NotFound | Refusal> {
    const res = await this.get(indexPath(opts.pack));
    const out = Reads.outcome(res, "private index");
    if (out) return out;
    const envelope = res.json() as PrivateIndex["envelope"];
    return {
      envelope,
      entries: envelope.entries.map((e) => PrivateEntry.parse(e)),
      raw: res.text,
      headers: Object.fromEntries(res.headers),
    };
  }

  async download(versionId: string): Promise<PrivateArchive | NotFound | Held | Refusal> {
    const res = await this.get(`/api/private/v/${versionId}`);
    const out = Reads.outcome(res, "private download");
    if (out) return out;
    if (res.status === 451) return new Held();
    const bytes = new TextEncoder().encode(res.text);
    return { bytes, sha256: await sha256Hex(bytes), headers: Object.fromEntries(res.headers) };
  }

  async observe(read: { index: { pack?: string } } | { download: string }): Promise<Observation> {
    return observed(await this.get("index" in read ? indexPath(read.index.pack) : `/api/private/v/${read.download}`));
  }
}

class Laptop implements Member {
  constructor(private readonly driver: Driver) {}

  private headersRequest(headers: Record<string, string>) {
    return (method: string, path: string) => this.driver.http.request({ surface: "web", method, path, headers: { "cf-connecting-ip": LAPTOP_ADDRESS, ...headers } });
  }

  inActionsOf(repo: ActionsRepo, o: { token?: "valid" | "wrong-audience" | "malformed" } = {}): PrivateReads {
    return new Reads(async () => {
      const oidc = this.driver.fakes?.oidc;
      if (!oidc) throw new InfrastructureError(`the ${this.driver.kind} driver has no fake token issuer, so a workflow cannot present a token`);
      const kind = o.token ?? "valid";
      const token =
        kind === "malformed"
          ? "not-a-token"
          : await oidc.mint(
              {
                sub: `repo:${repo.repository}:ref:refs/heads/main`,
                repository: repo.repository,
                repository_id: "7001",
                repository_owner_id: String(repo.ownerId),
                repository_visibility: repo.visibility,
                ref: "refs/heads/main",
                ref_protected: "true",
                job_workflow_ref: `${repo.repository}/.github/workflows/claudinite-update.yml@refs/heads/main`,
                event_name: "schedule",
                sha: "a".repeat(40),
                run_id: "1",
                jti: crypto.randomUUID(),
              },
              kind === "wrong-audience" ? { aud: "https://elsewhere.example" } : {},
            );
      return { request: this.headersRequest({ authorization: `Bearer ${token}` }) };
    });
  }

  withToken(token: string | { value: string }): PrivateReads {
    const value = typeof token === "string" ? token : token.value;
    return new Reads(async () => ({ request: this.headersRequest({ authorization: `Bearer ${value}` }) }));
  }

  signedInAs(user: User): PrivateReads {
    return new Reads(async () => ({ request: (method, path) => user.request(method, path) }));
  }

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

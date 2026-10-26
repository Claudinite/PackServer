import { TURNSTILE_PASS_TOKEN } from "@packserver/ports/fakes";
import type { ApiResponse, Driver } from "../../drivers/driver";
import type { FakeGitHubAccount } from "../../fakes/github-login";
import type { Aliases } from "../alias";
import { InfrastructureError, NotImplemented, stubModule } from "../errors";
import { createMail } from "../mail";
import { createUserTokens, type UserTokens } from "../tokens";
import { Refusal, type Observation, type RefusalReason } from "../outcomes";
import type {
  AccountInfo, Assertion, FormFaults, Notification, Publisher, PublisherOpts, Session, SessionCookie, SessionInfo, User, UserOpts, Visitor,
} from "../types";

/** People: members, publishers, anonymous visitors and the personas that name states requirements use. */
export interface UsersModule {
  users: {
    create(opts?: UserOpts): Promise<User>;
    /** A GitHub identity with no account yet: the first `signIn` creates one, with no handle. */
    newcomer(opts?: UserOpts): User;
    /** A link to a site other than this one. */
    readonly foreignLink: string;
  };
  publishers: { create(opts?: PublisherOpts): Promise<Publisher> };
  personas: {
    verifiedPublisher(name: string): Promise<Publisher>;
    youngUser(): Promise<User>;
    suspendedPublisher(): Promise<Publisher>;
  };
  visitor(): Visitor;
}

/** The in-process driver addresses a Worker by name; its origin is what the site compares a form's `Origin` with. */
const ORIGIN = "http://web.internal";
const FOREIGN_ORIGIN = "https://evil.example";
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const SESSION_COOKIE = "__Host-session";
const STATE_COOKIE = "__Host-github-state";

interface Client {
  ip: string;
  humanCheck: "pass" | "fail";
}

/** One person, whichever session or network address a scenario views them from. */
class Account {
  handle: string | null = null;
  current: Session | undefined;
  constructor(
    readonly github: FakeGitHubAccount,
    readonly email: string,
  ) {}
}

interface Context {
  driver: Driver;
  aliases: Aliases;
}

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const cookieValue = (response: ApiResponse, name: string): string | undefined => {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0]!;
    if (pair.startsWith(`${name}=`)) return line;
  }
  return undefined;
};

function parseCookie(line: string): { value: string; attributes: SessionCookie } {
  const [pair, ...rest] = line.split(";").map((part) => part.trim());
  const eq = pair!.indexOf("=");
  const attribute = (name: string) => rest.find((a) => a.toLowerCase().startsWith(`${name.toLowerCase()}=`))?.slice(name.length + 1);
  const flag = (name: string) => rest.some((a) => a.toLowerCase() === name.toLowerCase());
  return {
    value: pair!.slice(eq + 1),
    attributes: {
      name: pair!.slice(0, eq),
      secure: flag("Secure"),
      httpOnly: flag("HttpOnly"),
      sameSite: attribute("SameSite"),
      path: attribute("Path"),
      domain: attribute("Domain"),
    },
  };
}

/** A refusal arrives as the site's JSON body; anything else from a verb that should have worked is a broken harness. */
function refusal(res: ApiResponse, what: string): Refusal {
  let body: { reason?: RefusalReason; message?: string; retry_after_s?: number };
  try {
    body = res.json() as typeof body;
  } catch {
    throw new InfrastructureError(`${what}: expected a refusal or success, got ${res.status} ${res.text.slice(0, 120)}`);
  }
  if (!body.reason) throw new InfrastructureError(`${what}: got ${res.status} without a reason: ${res.text.slice(0, 120)}`);
  return new Refusal(body.reason, {
    ...(body.message === undefined ? {} : { message: body.message }),
    ...(body.retry_after_s === undefined ? {} : { retryAfterS: body.retry_after_s }),
  });
}

const observe = (res: ApiResponse): Observation => ({
  status: res.status,
  headers: Object.fromEntries([...res.headers].filter(([name]) => name !== "date" && name !== "set-cookie")),
  body: res.text,
});

interface Request {
  method: string;
  path: string;
  session?: Session | undefined;
  cookies?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  headers?: Record<string, string>;
}

/** One HTTP request as a browser at `client` would make it, cookies and form encoding included. */
function request(driver: Driver, client: Client, req: Request): Promise<ApiResponse> {
  const headers: Record<string, string> = { "user-agent": BROWSER, "cf-connecting-ip": client.ip, "cf-ipcountry": "NO", ...req.headers };
  const cookies = { ...(req.session ? { [SESSION_COOKIE]: req.session.id } : {}), ...req.cookies };
  if (Object.keys(cookies).length > 0) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  let body: string | undefined;
  if (req.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(req.form).toString();
  } else if (req.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  return driver.http.request({ surface: "web", method: req.method, path: req.path, headers, ...(body === undefined ? {} : { body }) });
}

class Person implements User {
  readonly sessions = {
    list: async (): Promise<SessionInfo[]> => {
      const res = await this.send({ method: "GET", path: "/api/auth/sessions", session: this.view });
      if (res.status !== 200) throw refusal(res, "sessions.list");
      const body = res.json() as { sessions: Array<{ id: string; device: SessionInfo["device"]; last_seen: number; current: boolean }> };
      return body.sessions.map((s) => ({ id: s.id, device: s.device, lastSeen: new Date(s.last_seen), current: s.current }));
    },
  };

  readonly account = {
    show: async (): Promise<AccountInfo> => {
      const res = await this.send({ method: "GET", path: "/api/auth/session", session: this.view });
      if (res.status !== 200) throw refusal(res, "account.show");
      const body = res.json() as { user: { id: string; handle: string | null }; identities: Array<{ provider: string; login: string | null }> };
      return { id: body.user.id, handle: body.user.handle, identities: body.identities };
    },
  };

  readonly tokens: UserTokens;

  constructor(
    private readonly ctx: Context,
    private readonly who: Account,
    private readonly client: Client,
    private readonly bound?: Session,
  ) {
    this.tokens = createUserTokens({
      send: (req) => this.send(req),
      formHeaders: (session) => this.formHeaders(session),
      session: () => this.view,
      refused: refusal,
      aliases: ctx.aliases,
    });
  }

  get handle(): string {
    return this.who.handle ?? "";
  }
  get email(): string {
    return this.who.email;
  }
  /** The session this view acts through. */
  private get view(): Session | undefined {
    return this.bound ?? this.who.current;
  }

  private get github() {
    const fakes = this.ctx.driver.fakes;
    if (!fakes) throw new InfrastructureError(`the ${this.ctx.driver.kind} driver has no fake GitHub: sign-in cannot be driven on a deployment`);
    return fakes.githubLogin;
  }

  as(session: Session): User {
    return new Person(this.ctx, this.who, this.client, session);
  }
  from(ip: string): User {
    return new Person(this.ctx, this.who, { ...this.client, ip }, this.bound);
  }
  failingHumanCheck(): User {
    return new Person(this.ctx, this.who, { ...this.client, humanCheck: "fail" }, this.bound);
  }

  private send(req: Request): Promise<ApiResponse> {
    return request(this.ctx.driver, this.client, req);
  }

  /** The headers a valid form post carries, each replaceable by a fault. */
  private async formHeaders(session: Session | undefined, faults: FormFaults = {}): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      origin: faults.origin === "foreign" ? FOREIGN_ORIGIN : ORIGIN,
      "idempotency-key": faults.idempotencyKey ?? crypto.randomUUID().replaceAll("-", ""),
    };
    if (faults.csrf !== "none") {
      const source = faults.csrf ?? session;
      const info = await this.send({ method: "GET", path: "/api/auth/session", session: source });
      if (info.status === 200) headers["x-csrf-token"] = (info.json() as { csrf: string }).csrf;
    }
    return headers;
  }

  async signIn(opts: { via?: "github" | "passkey" | "email"; next?: string } = {}): Promise<Session> {
    if (opts.via && opts.via !== "github") throw new NotImplemented(`users.signIn via ${opts.via}`);
    const held = this.view;
    const start = await this.send({
      method: "POST",
      path: "/api/auth/github",
      session: held,
      form: { next: opts.next ?? "", "cf-turnstile-response": this.client.humanCheck === "pass" ? TURNSTILE_PASS_TOKEN : "not-a-passing-token" },
    });
    if (start.status !== 303) throw refusal(start, "signIn");
    const state = cookieValue(start, STATE_COOKIE);
    const authorize = start.headers.get("location");
    if (!state || !authorize) throw new InfrastructureError("signIn: the site did not send the person to GitHub with a state cookie");

    const callback = new URL(this.github.approve(authorize, this.who.github.id));
    const finish = await this.send({
      method: "GET",
      path: callback.pathname + callback.search,
      session: held,
      cookies: { [STATE_COOKIE]: parseCookie(state).value },
    });
    if (finish.status !== 303) throw refusal(finish, "signIn");
    const line = cookieValue(finish, SESSION_COOKIE);
    if (!line) throw new InfrastructureError("signIn: the site finished sign-in without setting a session cookie");
    const { value, attributes } = parseCookie(line);
    const session: Session = { id: value, landedOn: finish.headers.get("location") ?? "", cookie: attributes };
    this.who.current = session;
    return session;
  }

  async signOut(faults?: FormFaults): Promise<void> {
    const session = this.view;
    const res = await this.send({ method: "POST", path: "/api/auth/signout", session, headers: await this.formHeaders(session, faults) });
    if (res.status !== 200) throw refusal(res, "signOut");
    if (this.who.current?.id === session?.id) this.who.current = undefined;
  }

  async chooseHandle(handle: string, faults?: FormFaults): Promise<void> {
    const session = this.view;
    const res = await this.send({ method: "POST", path: "/api/auth/handle", session, json: { handle }, headers: await this.formHeaders(session, faults) });
    if (res.status !== 200) throw refusal(res, "chooseHandle");
    this.who.handle = handle;
  }

  /** Used by `users.create`, which names the person by the scenario's word and the system by its alias. */
  async claimHandle(name: string, system: string): Promise<void> {
    await this.chooseHandle(system);
    this.who.handle = name;
  }

  assertionFor(): Promise<Assertion> {
    throw new NotImplemented("users.assertionFor");
  }
  star(): Promise<void> {
    throw new NotImplemented("users.star");
  }
  open(): Promise<unknown> {
    throw new NotImplemented("users.open");
  }
  async inbox(): Promise<Notification[]> {
    return createMail(this.ctx.driver).inbox(this).all().map((m) => ({ subject: m.subject }));
  }
}

export const createUsers = (driver: Driver, aliases: Aliases): UsersModule => {
  let people = 0;

  const newcomer = (opts: UserOpts = {}, name = opts.handle): { person: Person; name: string } => {
    if (opts.via && opts.via !== "github") throw new NotImplemented(`users.create via ${opts.via}`);
    if (opts.mfa) throw new NotImplemented("users.create with mfa");
    if (opts.ageDays !== undefined) throw new NotImplemented("users.create with ageDays");
    const fakes = driver.fakes;
    if (!fakes) throw new InfrastructureError(`the ${driver.kind} driver has no fake GitHub: an account cannot be made on a deployment`);
    const label = name ?? `person${++people}`;
    const system = aliases.alias(label);
    const email = opts.email ?? `${system}@example.test`;
    const github = fakes.githubLogin.register({
      id: 1_000_000 + (hash(system) % 900_000_000),
      login: system,
      name: label,
      emails: [{ email, verified: opts.emailVerified ?? true, primary: true }],
      orgs: opts.githubOrgs ?? [],
    });
    const who = new Account(github, email);
    const client: Client = { ip: `198.51.${(hash(system) >>> 8) & 255}.${hash(system) & 255}`, humanCheck: "pass" };
    return { person: new Person({ driver, aliases }, who, client), name: label };
  };

  return {
    users: {
      foreignLink: `${FOREIGN_ORIGIN}/x`,
      newcomer: (opts) => newcomer(opts).person,
      async create(opts = {}) {
        const { person, name } = newcomer(opts);
        await person.signIn();
        await person.claimHandle(name, aliases.alias(name));
        await person.signOut();
        return person;
      },
    },
    publishers: stubModule("publishers"),
    personas: stubModule("personas"),
    visitor(): Visitor {
      const client: Client = { ip: `198.51.${(hash(aliases.alias("visitor")) >>> 8) & 255}.${hash(aliases.alias("visitor")) & 255}`, humanCheck: "pass" };
      const send = (method: string, path: string, form?: Record<string, string>) =>
        request(driver, client, { method, path, ...(form ? { form } : {}) }).then(observe);
      return {
        open: () => {
          throw new NotImplemented("visitor.open");
        },
        get: (path) => send("GET", path),
        signInWith: (provider) => send("POST", `/api/auth/${encodeURIComponent(provider)}`, { "cf-turnstile-response": TURNSTILE_PASS_TOKEN }),
      };
    },
  };
};

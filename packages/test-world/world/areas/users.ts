import type { WorkerName } from "@packserver/ports";
import { VirtualAuthenticator } from "@packserver/core/identity/virtual-authenticator";
import { TURNSTILE_PASS_TOKEN } from "@packserver/ports/fakes";
import type { ApiResponse, Driver } from "../../drivers/driver";
import type { FakeGitHubAccount } from "../../fakes/github-login";
import type { Aliases } from "../alias";
import { InfrastructureError, NotImplemented, stubModule } from "../errors";
import { createMail } from "../mail";
import { createUserTokens, type UserTokens } from "../tokens";
import { NotFound, Refusal, type Observation, type RefusalReason } from "../outcomes";
import { SELFTEST_PATHS } from "./operator";
import type {
  AccountInfo, Assertion, HistoryEntry, AssertionChoice, FormFaults, Notification, Passkey, PasskeyInfo, Publisher, PublisherOpts, RecoveryInfo, Sensitive,
  SensitiveAction, Session, SessionCookie, SessionInfo, User, UserOpts, Visitor,
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
  userAgent?: string;
  country?: string;
}

/** One person, whichever session or network address a scenario views them from. */
class Account {
  handle: string | null = null;
  current: Session | undefined;
  /** The person's authenticator, which holds every passkey they enrolled. */
  readonly device = new VirtualAuthenticator();
  /** The recovery codes last shown. */
  codes: string[] = [];
  /** The assertion most recently spent, for a scenario that presents it again. */
  spent: Assertion | undefined;
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
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
}

/** One HTTP request as a browser at `client` would make it, cookies and form encoding included. */
function request(driver: Driver, client: Client, req: Request): Promise<ApiResponse> {
  const headers: Record<string, string> = { "user-agent": client.userAgent ?? BROWSER, "cf-connecting-ip": client.ip, "cf-ipcountry": client.country ?? "NO", ...req.headers };
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
  return driver.http.request({ surface: "web", method: req.method, path: req.path, headers, ...(req.rawBody ? { body: req.rawBody } : body === undefined ? {} : { body }) });
}

export interface CallRequest {
  method: string;
  path: string;
  json?: unknown;
  headers?: Record<string, string>;
  faults?: FormFaults;
}

/** What an area module needs to act as a person it did not create. */
export interface Caller {
  call(req: CallRequest): Promise<ApiResponse>;
  /** The headers a sensitive request carries for the action, as `assertion` asks; the person enrols a first passkey when there is none. */
  assertionHeaders(action: string, o?: Sensitive, target?: string): Promise<Record<string, string>>;
}

export function callerOf(user: User): Caller {
  if (typeof (user as Partial<Caller>).call !== "function") throw new InfrastructureError("this person was not made by the users module, so it cannot act through a session");
  return user as User & Caller;
}

class Person implements User {
  readonly sessions = {
    list: async (): Promise<SessionInfo[]> => {
      const res = await this.send({ method: "GET", path: "/api/auth/sessions", session: this.view });
      if (res.status !== 200) throw refusal(res, "sessions.list");
      const body = res.json() as { sessions: Array<{ id: string; device: SessionInfo["device"]; last_seen: number; current: boolean }> };
      return body.sessions.map((s) => ({ id: s.id, device: s.device, lastSeen: new Date(s.last_seen), current: s.current }));
    },
    revoke: async (session: { id: string }, faults?: FormFaults): Promise<void> => {
      const view = this.view;
      const own = session.id === (await this.sessionHash(view));
      const res = await this.send({
        method: "POST", path: `/api/auth/sessions/${encodeURIComponent(session.id)}/revoke`, session: view, json: {}, headers: await this.formHeaders(view, faults),
      });
      if (res.status !== 200) throw refusal(res, "sessions.revoke");
      if (own) this.who.current = undefined;
    },
  };

  readonly account = {
    show: async (): Promise<AccountInfo> => {
      const res = await this.send({ method: "GET", path: "/api/auth/session", session: this.view });
      if (res.status !== 200) throw refusal(res, "account.show");
      const body = res.json() as { user: { id: string; handle: string | null }; identities: Array<{ provider: string; login: string | null }> };
      return { id: body.user.id, handle: body.user.handle, identities: body.identities };
    },
    delete: async (o: Sensitive = {}): Promise<void> => {
      const userId = await this.ownId();
      const res = await this.sensitivePost("/api/auth/delete", { action: "account.delete", target: userId }, o);
      if (res.status !== 200) throw refusal(res, "account.delete");
      this.who.current = undefined;
    },
    history: async (): Promise<HistoryEntry[]> => {
      const res = await this.send({ method: "GET", path: "/api/auth/history", session: this.view });
      if (res.status !== 200) throw refusal(res, "account.history");
      const body = res.json() as { events: Array<{ at: string; action: string; target: string | null }> };
      return body.events.map((e) => ({ at: new Date(e.at), action: e.action, target: e.target }));
    },
  };

  readonly providers = {
    linkGitHub: async (o: Sensitive = {}): Promise<void> => {
      const session = this.view;
      const res = await this.sensitivePost("/api/auth/providers/github/link", { action: "provider.link", target: "github" }, o, {});
      if (res.status !== 200) throw refusal(res, "providers.linkGitHub");
      const state = cookieValue(res, STATE_COOKIE);
      const authorize = (res.json() as { redirect: string }).redirect;
      if (!state) throw new InfrastructureError("providers.linkGitHub: the site sent no state cookie");
      const callback = new URL(this.github.approve(authorize, this.who.github.id));
      const finish = await this.send({
        method: "GET", path: callback.pathname + callback.search, session: this.view ?? session, cookies: { [STATE_COOKIE]: parseCookie(state).value },
      });
      if (finish.status !== 303) throw refusal(finish, "providers.linkGitHub");
    },
  };

  readonly recovery = {
    /** Asks for a recovery by an address; the site answers the same whatever it did. */
    request: async (address?: string): Promise<void> => {
      const res = await this.send({
        method: "POST", path: "/api/auth/recovery/request", json: { email: address ?? this.who.email },
        headers: { "cf-turnstile-response": this.client.humanCheck === "pass" ? TURNSTILE_PASS_TOKEN : "not-a-passing-token" },
      });
      if (res.status !== 202) throw refusal(res, "recovery.request");
    },
    /** Stops the recovery with the link in the newest "recovery requested" mail the address received. */
    cancelFromMail: async (address?: string): Promise<void> => {
      const mail = createMail(this.ctx.driver).inbox({ email: address ?? this.who.email }).all().filter((m) => /recovery requested/i.test(m.subject));
      const token = /[?&]token=([0-9a-f]{64})/.exec(mail.at(-1)?.text ?? "")?.[1];
      if (!token) throw new InfrastructureError("recovery.cancelFromMail: no notice with a cancel link has been mailed");
      const res = await this.send({ method: "POST", path: "/api/auth/recovery/cancel-link", json: { token }, headers: { origin: ORIGIN } });
      if (res.status !== 200) throw refusal(res, "recovery.cancelFromMail");
    },
    /** The signed-in person stops their own open recovery. */
    cancel: async (): Promise<void> => {
      const session = this.view;
      const res = await this.send({ method: "POST", path: "/api/auth/recovery/cancel", session, json: {}, headers: await this.formHeaders(session) });
      if (res.status !== 200) throw refusal(res, "recovery.cancel");
    },
    /** Follows the link in the newest approval mail the address received. */
    signIn: async (address?: string, faults: FormFaults = {}): Promise<Session> => {
      const mail = createMail(this.ctx.driver).inbox({ email: address ?? this.who.email }).all().filter((m) => /recovery was approved/i.test(m.subject));
      const token = /[?&]token=([0-9a-f]{64})/.exec(mail.at(-1)?.text ?? "")?.[1];
      if (!token) throw new InfrastructureError("recovery.signIn: no approval link has been mailed");
      const res = await this.send({
        method: "POST", path: "/api/auth/recovery/complete", json: { token }, headers: { origin: faults.origin === "foreign" ? FOREIGN_ORIGIN : ORIGIN },
      });
      if (res.status !== 200) throw refusal(res, "recovery.signIn");
      const line = cookieValue(res, SESSION_COOKIE);
      if (!line) throw new InfrastructureError("recovery.signIn: the site set no session cookie");
      const { value, attributes } = parseCookie(line);
      const session: Session = { id: value, landedOn: (res.json() as { landed_on: string }).landed_on, cookie: attributes };
      this.who.current = session;
      return session;
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
      assertionHeaders: (action, o, target) => this.assertionHeaders(action, o, target),
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
  onDevice(device: { userAgent?: string; country?: string }): User {
    return new Person(this.ctx, this.who, { ...this.client, ...device }, this.bound);
  }

  /** The hash the site lists a session under. */
  private async sessionHash(session: Session | undefined): Promise<string | undefined> {
    const res = await this.send({ method: "GET", path: "/api/auth/session", session });
    return res.status === 200 ? (res.json() as { session: { id: string } }).session.id : undefined;
  }

  /** What the world does to a person that they cannot do themselves: take their passkeys and linked sign-ins away, as loss would. */
  async loseFactors(which: { passkeys?: boolean; providers?: boolean }): Promise<void> {
    const driver = this.ctx.driver;
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver has no storage seam`);
    const { db } = await driver.storage();
    const userId = await this.ownId();
    const run = (sql: string) => db.batch([db.prepare(sql).bind(userId)]);
    if (which.passkeys) {
      await run("delete from credential_flags where credential_id in (select id from credentials where user_id = ?1)");
      await run("delete from credentials where user_id = ?1");
      await run("delete from recovery_codes where user_id = ?1");
      await run("delete from recovery_sets where user_id = ?1");
      this.who.codes = [];
    }
    if (which.providers) await run("delete from identities where user_id = ?1");
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
    if (opts.via === "email") throw new NotImplemented(`users.signIn via ${opts.via}`);
    if (opts.via === "passkey") return this.signInWithPasskey(opts.next);
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

  /** A person with no passkey yet signs up with one; one who has a passkey signs in with it. */
  private async signInWithPasskey(next?: string): Promise<Session> {
    const held = this.view;
    const human = { "cf-turnstile-response": this.client.humanCheck === "pass" ? TURNSTILE_PASS_TOKEN : "not-a-passing-token" };
    const signingUp = this.who.device.ids().length === 0;
    const phase = signingUp ? "signup" : "signin";
    const start = await this.send({ method: "POST", path: `/api/auth/passkey/${phase}/options`, session: held, json: {}, headers: human });
    if (start.status !== 200) throw refusal(start, "signIn");
    const options = (start.json() as { options: Parameters<VirtualAuthenticator["create"]>[0] & Parameters<VirtualAuthenticator["get"]>[0] }).options;
    const response = signingUp ? await this.who.device.create(options, ORIGIN) : await this.who.device.get(options, ORIGIN);
    const finish = await this.send({
      method: "POST", path: `/api/auth/passkey/${phase}/verify`, session: held, json: { response, ...(next ? { next } : {}) },
    });
    if (finish.status !== 200) throw refusal(finish, "signIn");
    const line = cookieValue(finish, SESSION_COOKIE);
    if (!line) throw new InfrastructureError("signIn: the site finished the passkey ceremony without setting a session cookie");
    const done = finish.json() as { landed_on: string; recovery_codes?: string[] };
    if (done.recovery_codes) this.who.codes = done.recovery_codes;
    const { value, attributes } = parseCookie(line);
    const session: Session = { id: value, landedOn: done.landed_on, cookie: attributes };
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

  /** A scope that predates the MFA rule, which makes the account a publisher without any gate having applied. */
  async seedScopeMembership(scope: string, driver: Driver): Promise<void> {
    if (!driver.storage) throw new InfrastructureError(`the ${driver.kind} driver cannot seed a scope: it has no storage`);
    const { db } = await driver.storage();
    const userId = await this.ownId();
    const at = new Date(await this.ctx.driver.fakes!.clock.call<number>("now")).toISOString();
    const name = this.ctx.aliases.alias(scope);
    // The id the CI seed gives a scope of this name, so either may create it first.
    const id = `scope-${name}`;
    await db.batch([
      db.prepare("insert or ignore into scopes (id, name, kind, state, created_at) values (?, ?, 'user', 'active', ?)").bind(id, name, at),
      db.prepare("insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'owner', ?)").bind(id, userId, at),
    ]);
  }

  /** Used by `users.create`, which names the person by the scenario's word and the system by its alias. */
  async claimHandle(name: string, system: string): Promise<void> {
    await this.chooseHandle(system);
    this.who.handle = name;
  }

  /** For area modules: one request in this person's session, carrying the headers a valid form would. */
  async call(req: CallRequest): Promise<ApiResponse> {
    const session = this.view;
    const { faults, headers, ...rest } = req;
    return this.send({ ...rest, session, headers: { ...(await this.formHeaders(session, faults)), ...headers } });
  }

  async assertionHeaders(action: string, o: Sensitive = {}, target = ""): Promise<Record<string, string>> {
    if (o.assertion !== "none" && (await this.mfa.passkeys()).length === 0) await this.mfa.enrol();
    return (await this.presented({ action, target }, o)).headers;
  }

  /** The action and target an assertion is made for; a verb's own name goes in `action`. */
  private subject(action: SensitiveAction): { action: string; target: string } {
    if (typeof action === "string") return { action, target: "" };
    if (typeof action.action !== "string") throw new InfrastructureError("assertionFor: name the action as a string or { action, target }");
    return { action: action.action, target: typeof action.target === "string" ? action.target : "" };
  }

  private async ownId(session?: Session): Promise<string> {
    const res = await this.send({ method: "GET", path: "/api/auth/session", session: session ?? this.view });
    if (res.status !== 200) throw refusal(res, "account");
    return (res.json() as { user: { id: string } }).user.id;
  }

  /** Follows a rotation: the session the site sent back replaces the one this view acted through. */
  private adopt(res: ApiResponse, from: Session | undefined): Session | undefined {
    const line = cookieValue(res, SESSION_COOKIE);
    if (!line) return undefined;
    const { value, attributes } = parseCookie(line);
    const next: Session = { id: value, cookie: attributes };
    if (this.who.current?.id === from?.id) this.who.current = next;
    return next;
  }

  async assertionFor(action: SensitiveAction, how: AssertionChoice = {}): Promise<Assertion> {
    const made = await this.attemptAssertion(this.subject(action), how);
    if (made.res.status !== 200) throw refusal(made.res, "assertionFor");
    return made.assertion!;
  }

  private async attemptAssertion(
    asked: { action: string; target: string },
    how: AssertionChoice & { badSignature?: boolean; wrongCode?: string },
  ): Promise<{ res: ApiResponse; assertion?: Assertion }> {
    const session = this.view;
    const headers = await this.formHeaders(session);
    const body: Record<string, unknown> = { ...asked };
    if (how.recoveryCode !== undefined || how.wrongCode !== undefined) {
      body.recovery_code = how.wrongCode ?? how.recoveryCode;
    } else {
      const opts = await this.send({ method: "POST", path: "/api/auth/assert/options", session, json: asked, headers });
      if (opts.status !== 200) return { res: opts };
      const options = (opts.json() as { options: Parameters<VirtualAuthenticator["get"]>[0] }).options;
      body.response = await this.who.device.get(options, ORIGIN, {
        ...(how.passkey ? { credentialId: how.passkey.credentialId } : {}),
        ...(how.badSignature ? { badSignature: true } : {}),
      });
    }
    const res = await this.send({ method: "POST", path: "/api/auth/assert", session, json: body, headers: await this.formHeaders(session) });
    if (res.status !== 200) return { res };
    const done = res.json() as {
      assertion: string; method: "passkey" | "recovery"; warning?: string; recovery_codes_remaining?: number; offer?: string;
    };
    const next = this.adopt(res, session);
    const assertion: Assertion = {
      ...asked,
      method: done.method,
      token: done.assertion,
      session: next ?? session!,
      madeOn: session?.id ?? "",
      ...(done.warning ? { notice: { warning: done.warning, remaining: done.recovery_codes_remaining ?? 0, offer: done.offer ?? "" } } : {}),
    };
    return { res, assertion };
  }

  async failAssertion(action: SensitiveAction, how: { recoveryCode?: string } = {}): Promise<void> {
    const made = await this.attemptAssertion(this.subject(action), how.recoveryCode === undefined ? { badSignature: true } : { wrongCode: how.recoveryCode });
    if (made.res.status === 200) throw new InfrastructureError("failAssertion: the site accepted an assertion that should not verify");
    const refused = refusal(made.res, "failAssertion");
    if (refused.reason !== "step-up" && refused.reason !== "rate-limited") throw refused;
  }

  /**
   * What a sensitive request carries: the verb's own assertion by default, none, or the one spent last.
   * The returned session is the one the request must act through.
   */
  private async presented(asked: { action: string; target: string }, o: Sensitive): Promise<{ headers: Record<string, string>; session: Session | undefined }> {
    const choice = o.assertion;
    if (choice === "none") return { headers: {}, session: this.view };
    const assertion = choice === "replay" ? this.who.spent : choice ?? (await this.assertionFor(asked));
    if (!assertion) throw new InfrastructureError("a replay needs an assertion spent earlier");
    this.who.spent = assertion;
    const here = this.view;
    // An assertion works through the session it was made on, however that session has been replaced since; another session just carries it.
    const own = here?.id === assertion.madeOn || here?.id === assertion.session.id;
    return { headers: { "x-assertion": assertion.token }, session: own ? assertion.session : here };
  }

  private async sensitivePost(path: string, asked: { action: string; target: string }, o: Sensitive, json?: unknown): Promise<ApiResponse> {
    const { headers, session } = await this.presented(asked, o);
    const res = await this.send({ method: "POST", path, session, json: json ?? {}, headers: { ...(await this.formHeaders(session)), ...headers } });
    this.adopt(res, session);
    return res;
  }

  readonly mfa = {
    enrol: async (o: Sensitive & { label?: string; faults?: FormFaults } = {}): Promise<Passkey & { recoveryCodes: string[] }> => {
      const userId = await this.ownId();
      const first = (await this.mfa.passkeys()).length === 0;
      // The assertion rotates the session, and the ceremony's challenge belongs to the session that finishes it.
      const { headers, session: acting } = first ? { headers: {}, session: this.view } : await this.presented({ action: "factor.add", target: userId }, o);
      const start = await this.send({ method: "POST", path: "/api/auth/passkey/enrol/options", session: acting, json: {}, headers: await this.formHeaders(acting, o.faults) });
      if (start.status !== 200) throw refusal(start, "mfa.enrol");
      const options = (start.json() as { options: Parameters<VirtualAuthenticator["create"]>[0] }).options;
      const response = await this.who.device.create(options, ORIGIN);
      const res = await this.send({
        method: "POST",
        path: "/api/auth/passkey/enrol/verify",
        session: acting,
        json: { response, ...(o.label ? { label: o.label } : {}) },
        headers: { ...(await this.formHeaders(acting, o.faults)), ...headers },
      });
      this.adopt(res, acting);
      if (res.status !== 200) throw refusal(res, "mfa.enrol");
      const done = res.json() as { factor: { id: string }; recovery_codes?: string[] };
      if (done.recovery_codes) this.who.codes = done.recovery_codes;
      return { id: done.factor.id, credentialId: response.id, recoveryCodes: done.recovery_codes ?? [] };
    },

    passkeys: async (): Promise<PasskeyInfo[]> => {
      const res = await this.send({ method: "GET", path: "/api/auth/factors", session: this.view });
      if (res.status !== 200) throw refusal(res, "mfa.passkeys");
      const body = res.json() as { passkeys: Array<{ id: string; label: string | null; last_used_at: string | null; hold_until: string | null }> };
      return body.passkeys.map((k) => ({ id: k.id, label: k.label, lastUsedAt: k.last_used_at, heldUntil: k.hold_until }));
    },

    codes: (): string[] => [...this.who.codes],

    remove: async (passkey: Passkey, o: Sensitive = {}): Promise<void> => {
      const res = await this.sensitivePost(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}/remove`, { action: "factor.remove", target: passkey.id }, o);
      if (res.status !== 200) throw refusal(res, "mfa.remove");
    },

    recovery: async (): Promise<RecoveryInfo> => {
      const res = await this.send({ method: "GET", path: "/api/auth/recovery", session: this.view });
      if (res.status !== 200) throw refusal(res, "mfa.recovery");
      const body = res.json() as { has_codes: boolean; saved: boolean; remaining: number };
      return { hasCodes: body.has_codes, saved: body.saved, remaining: body.remaining };
    },

    confirmCodesSaved: async (): Promise<void> => {
      const session = this.view;
      const res = await this.send({ method: "POST", path: "/api/auth/recovery/saved", session, json: {}, headers: await this.formHeaders(session) });
      if (res.status !== 200) throw refusal(res, "mfa.confirmCodesSaved");
    },

    regenerateCodes: async (o: Sensitive = {}): Promise<string[]> => {
      const userId = await this.ownId();
      const res = await this.sensitivePost("/api/auth/recovery/regenerate", { action: "recovery.regenerate", target: userId }, o);
      if (res.status !== 200) throw refusal(res, "mfa.regenerateCodes");
      this.who.codes = (res.json() as { recovery_codes: string[] }).recovery_codes;
      return this.who.codes;
    },

    pages: async (): Promise<string> => {
      const texts: string[] = [];
      for (const path of ["/api/auth/session", "/api/auth/sessions", "/api/auth/factors", "/api/auth/recovery"]) {
        texts.push((await this.send({ method: "GET", path, session: this.view })).text);
      }
      return texts.join("\n");
    },
  };
  readonly deviceSignIn = {
    open: async (): Promise<Observation> => observe(await this.send({ method: "GET", path: "/api/auth/device/verify", session: this.view })),
    enter: (userCode: string) => this.deviceStep("/api/auth/device/verify", { user_code: userCode }),
    allow: (userCode: string) => this.deviceStep("/api/auth/device/decision", { user_code: userCode, decision: "approve" }),
    deny: (userCode: string) => this.deviceStep("/api/auth/device/decision", { user_code: userCode, decision: "deny" }),
  };

  private async deviceStep(path: string, form: Record<string, string>): Promise<Observation> {
    const session = this.view;
    return observe(await this.send({ method: "POST", path, session, form, headers: await this.formHeaders(session) }));
  }

  star(): Promise<void> {
    throw new NotImplemented("users.star");
  }
  open(): Promise<unknown> {
    throw new NotImplemented("users.open");
  }
  async request(method: string, path: string, o: { json?: unknown; body?: Uint8Array } = {}): Promise<ApiResponse> {
    const session = this.view;
    const headers = method === "GET" ? {} : await this.formHeaders(session);
    if (o.body) headers["content-type"] = "application/octet-stream";
    return this.send({ method, path, session, headers, ...(o.json !== undefined ? { json: o.json } : {}), ...(o.body ? { rawBody: o.body } : {}) });
  }

  async inbox(): Promise<Notification[]> {
    return createMail(this.ctx.driver).inbox(this).all().map((m) => ({ subject: m.subject }));
  }
}

export const createUsers = (driver: Driver, aliases: Aliases): UsersModule => {
  let people = 0;

  const newcomer = (opts: UserOpts = {}, name = opts.handle): { person: Person; name: string } => {
    if (opts.via === "email") throw new NotImplemented(`users.create via ${opts.via}`);
    if (opts.mfa === "totp") throw new NotImplemented("users.create with totp");
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
      emails: [
        { email, verified: opts.emailVerified ?? true, primary: true },
        ...(opts.moreEmails ?? []).map((extra) => ({ email: extra, verified: true, primary: false })),
      ],
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
        await person.signIn(opts.via === "passkey" ? { via: "passkey" } : {});
        await person.claimHandle(name, aliases.alias(name));
        if (opts.mfa === "passkey" && opts.via !== "passkey") await person.mfa.enrol();
        if (opts.seedScope) await person.seedScopeMembership(opts.seedScope, driver);
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
        async selfTest(o = {}) {
          const worker = (o.worker ?? "web") as WorkerName;
          const ask = (path: string) => driver.http.request({ surface: worker, method: "GET", path, headers: { "cf-connecting-ip": client.ip }, unsigned: true }).then(observe);
          const [answered, unknown] = [await ask(SELFTEST_PATHS[worker]), await ask("/no/such/path")];
          return JSON.stringify(answered) === JSON.stringify(unknown) ? new NotFound() : answered;
        },
      };
    },
  };
};

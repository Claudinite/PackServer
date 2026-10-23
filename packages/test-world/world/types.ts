// The handle interfaces scenarios write against (dsl.md §4). A handle is a cheap view: it hits the
// system only when a verb or observation does. Area tasks fill the modules that return them.

import type { Observation } from "./outcomes";

export type Duration = string;

/** The session cookie as the site set it, read from the `Set-Cookie` line. */
export interface SessionCookie {
  readonly name: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: string | undefined;
  readonly path: string | undefined;
  /** A host-only cookie has none. */
  readonly domain: string | undefined;
}
export interface Session {
  readonly id: string;
  /** Where the site sent the person when sign-in finished. */
  readonly landedOn?: string;
  readonly cookie?: SessionCookie;
}
export interface SessionInfo {
  /** Safe to show; never the cookie value. */
  readonly id: string;
  readonly device: { label: string; country: string };
  readonly lastSeen: Date;
  readonly current: boolean;
}
export interface AccountInfo {
  readonly id: string;
  readonly handle: string | null;
  readonly identities: ReadonlyArray<{ provider: string; login: string | null }>;
}
/** What a form's request carries beyond a valid one; each field is a way to send it wrong. */
export interface FormFaults {
  /** `'none'` sends no CSRF token; a session sends that session's token instead of this one's. */
  csrf?: "none" | Session;
  origin?: string;
  idempotencyKey?: string;
}
export interface Assertion {
  readonly action: string;
}
export type SensitiveAction = string | Record<string, unknown>;
export interface Sensitive {
  assertion?: "none" | "replay" | Assertion;
}

export interface Pack {
  readonly name: string;
  readonly systemName: string;
  version(version: string): Version;
  versions(): Promise<Version[]>;
  latest(): Promise<Version>;
  as(user: User): Pack;
  setVisibility(visibility: "public" | "private", o?: Sensitive): Promise<void>;
}
export interface Org {
  readonly name: string;
}
export interface Scope {
  readonly name: string;
}
export interface Archive {
  readonly fixture: string;
}
export interface Report {
  readonly verdict: string;
}
export interface ValidationRun {
  verdict(): Promise<"pass" | "warn" | "hold" | "fail" | "rejected" | "error">;
}

export type VersionStatus = "active" | "deprecated" | "yanked" | "quarantined" | "revoked" | "removed";
export interface Verification {
  verified: boolean;
  verifiedDomain?: string;
  verifiedGithubOrg?: string;
}
export interface Version {
  readonly pack: Pack;
  readonly version: string;
  status(): Promise<VersionStatus>;
  sha256(): Promise<string>;
  approve(o?: Sensitive): Promise<void>;
  deprecate(reason: string, o?: Sensitive): Promise<void>;
  yank(o: { reason: string; security?: boolean } & Sensitive): Promise<void>;
  unyank(o?: Sensitive): Promise<void>;
  delete(o?: Sensitive): Promise<void>;
  verification(): Promise<Verification>;
}

export interface UserOpts {
  email?: string;
  ageDays?: number;
  via?: "github" | "passkey" | "email";
  mfa?: "passkey" | "totp";
  handle?: string;
  /** The GitHub organisations the person belongs to, as GitHub reports them at sign-in. */
  /** Whether GitHub vouches for the address; default true. */
  emailVerified?: boolean;
  githubOrgs?: Array<{ id: number; login: string; role: "admin" | "member" }>;
}
export interface PublisherOpts {
  credits?: number;
  verified?: boolean;
}
export interface Notification {
  readonly subject: string;
}

export interface User {
  readonly handle: string;
  /** The aliased address, for asserting what a record must not contain. */
  readonly email: string;
  as(session: Session): User;
  signIn(opts?: { via?: "github" | "passkey" | "email"; next?: string }): Promise<Session>;
  signOut(o?: FormFaults): Promise<void>;
  assertionFor(action: SensitiveAction): Promise<Assertion>;
  /** Sends the handle as given: a scenario that tests a reserved or taken name must not have it aliased. */
  chooseHandle(handle: string, o?: FormFaults): Promise<void>;
  sessions: { list(): Promise<SessionInfo[]> };
  account: { show(): Promise<AccountInfo> };
  /** The same person at another network address. */
  from(ip: string): User;
  /** The same person with a browser that cannot pass the human check. */
  failingHumanCheck(): User;
  star(pack: Pack): Promise<void>;
  open(pack: Pack): Promise<unknown>;
  inbox(): Promise<Notification[]>;
}
export interface Publisher extends User {
  scope: Scope;
  publish(archive: Archive): { as(nameAtVersion: string, o?: { visibility?: "private"; staged?: true }): Promise<Version> };
  dryRun(archive: Archive, o?: { proseScreen?: boolean }): Promise<Report>;
}

export interface Visitor {
  open(pack: Pack): Promise<unknown>;
  /** What the site answers to a GET, in the headers the World names. */
  get(path: string): Promise<Observation>;
  /** A sign-in request naming a provider. */
  signInWith(provider: string): Promise<Observation>;
}

export interface Agent {
  tools(): Promise<string[]>;
  search(query: string): Promise<unknown>;
}

export interface Admin {
  readonly handle: string;
}

export interface Member {
  fetchRoot(): Promise<unknown>;
  fetchIndex(scope: string): Promise<unknown>;
  adopt(pack: Pack, version: string): Promise<unknown>;
}
export interface MemberPolicy {
  allowPublishers?: "verified" | { domains: ReadonlyArray<string> };
}

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string | object;
}
export interface SelfTest {
  readonly ok: boolean;
  readonly versionId: string;
  readonly releaseId: string;
  readonly checks: ReadonlyArray<SelfTestCheck>;
  check(name: string): SelfTestCheck | undefined;
}

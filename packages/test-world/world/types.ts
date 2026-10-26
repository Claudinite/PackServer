// The handle interfaces scenarios write against (dsl.md §4). A handle is a cheap view: it hits the
// system only when a verb or observation does. Area tasks fill the modules that return them.

import type { ApiResponse } from "../drivers/driver";
import type { Observation } from "./outcomes";
import type { UserTokens } from "./tokens";

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
export interface HistoryEntry {
  readonly at: Date;
  readonly action: string;
  readonly target: string | null;
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
  /** `'foreign'` sends the form as another site would. */
  origin?: "foreign";
  idempotencyKey?: string;
}
/** What a passkey ceremony or a recovery code left for the one request it was made for. */
export interface Assertion {
  readonly action: string;
  readonly target: string;
  readonly method: "passkey" | "recovery";
  /** The secret the one sensitive request carries in `x-assertion`. */
  readonly token: string;
  /** The session the assertion was made on, which the site replaced; the request must use this one. */
  readonly session: Session;
  /** The id that session had before the site replaced it. */
  readonly madeOn: string;
  /** Set when a recovery code made the assertion: the warning and the offer the site gave. */
  readonly notice?: { readonly warning: string; readonly remaining: number; readonly offer: string };
}
/** A passkey the person enrolled, by the site's id and the authenticator's. */
export interface Passkey {
  readonly id: string;
  readonly credentialId: string;
}
export interface PasskeyInfo {
  readonly id: string;
  readonly label: string | null;
  readonly lastUsedAt: string | null;
  /** When the passkey stops being on hold for publish approvals and the like; absent when it is not. */
  readonly heldUntil: string | null;
}
export interface RecoveryInfo {
  readonly hasCodes: boolean;
  readonly saved: boolean;
  readonly remaining: number;
}
/** How an assertion is made: with a particular passkey, or with a recovery code instead. */
export interface AssertionChoice {
  passkey?: Passkey;
  recoveryCode?: string;
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
  /** Further verified addresses GitHub reports for the person. */
  moreEmails?: string[];
  /** Makes the person a member of a scope created before MFA was required, as the seed does. */
  seedScope?: string;
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
  assertionFor(action: SensitiveAction, how?: AssertionChoice): Promise<Assertion>;
  /** Attempts an assertion that does not verify; resolves once the site has refused it, and rejects if it did not. */
  failAssertion(action: SensitiveAction, how?: { recoveryCode?: string }): Promise<void>;
  mfa: {
    /** The first passkey needs nothing; later ones need an assertion for adding a factor, made for the person by default. */
    enrol(o?: Sensitive & { label?: string; faults?: FormFaults }): Promise<Passkey & { recoveryCodes: string[] }>;
    passkeys(): Promise<PasskeyInfo[]>;
    /** The recovery codes the person was last shown, as the person's own note of them. */
    codes(): string[];
    remove(passkey: Passkey, o?: Sensitive): Promise<void>;
    recovery(): Promise<RecoveryInfo>;
    confirmCodesSaved(): Promise<void>;
    /** Replaces the set and returns the new codes; the stand-in for a sensitive verb whose target is the person. */
    regenerateCodes(o?: Sensitive): Promise<string[]>;
    /** Everything the account and security APIs say, as one text, to look for what must never appear there. */
    pages(): Promise<string>;
  };
  /** Sends the handle as given: a scenario that tests a reserved or taken name must not have it aliased. */
  chooseHandle(handle: string, o?: FormFaults): Promise<void>;
  sessions: {
    list(): Promise<SessionInfo[]>;
    /** Ends one of the person's sessions, by the id the list shows. */
    revoke(session: { id: string }, o?: FormFaults): Promise<void>;
  };
  tokens: UserTokens;
  account: {
    show(): Promise<AccountInfo>;
    delete(o?: Sensitive): Promise<void>;
    /** The person's own logins, factor changes and tokens, newest first. */
    history(): Promise<HistoryEntry[]>;
  };
  providers: { linkGitHub(o?: Sensitive): Promise<void> };
  recovery: {
    /** Asks for a recovery by an address (the person's own by default) without signing in. */
    request(address?: string): Promise<void>;
    /** Follows the link an approved recovery mailed, which signs the person in with no factor. */
    signIn(address?: string, faults?: FormFaults): Promise<Session>;
    /** Stops the recovery with the cancel link in the notice mailed to the address. */
    cancelFromMail(address?: string): Promise<void>;
    /** The signed-in person stops their own open recovery. */
    cancel(): Promise<void>;
  };
  /** The same person from another browser or country. */
  onDevice(device: { userAgent?: string; country?: string }): User;
  /** Takes passkeys and linked sign-ins away as loss would, which no verb of the person's own can do. */
  loseFactors(which: { passkeys?: boolean; providers?: boolean }): Promise<void>;
  /** The same person at another network address. */
  from(ip: string): User;
  /** The same person with a browser that cannot pass the human check. */
  failingHumanCheck(): User;
  star(pack: Pack): Promise<void>;
  open(pack: Pack): Promise<unknown>;
  inbox(): Promise<Notification[]>;
  /**
   * One request as this person's browser makes it, for the area modules that act as a person: the session cookie
   * and, for an unsafe method, the origin, CSRF token and idempotency key.
   */
  request(method: string, path: string, o?: { json?: unknown; body?: Uint8Array }): Promise<ApiResponse>;
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

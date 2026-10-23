// The handle interfaces scenarios write against (dsl.md §4). A handle is a cheap view: it hits the
// system only when a verb or observation does. Area tasks fill the modules that return them.

export type Duration = string;

export interface Session {
  readonly id: string;
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
  signOut(): Promise<void>;
  assertionFor(action: SensitiveAction): Promise<Assertion>;
  chooseHandle(handle: string): Promise<void>;
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

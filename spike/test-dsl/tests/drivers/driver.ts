// Layer 3 boundary. The World talks to the system only through this interface;
// drivers are the only code that knows URLs, verbs and status codes.
import type { Fakes } from "../fakes/fakes";
import type { Recorder } from "../world/recorder";

export type Session = { token: string; email: string };
export type PackSpec = { name: string; summary: string; visibility: "public" | "private"; archive: string };
export type PackInfo = { name: string; summary?: string; visibility: "public" | "private"; validation?: string | null };

/** Outcome of an action the system may refuse. Never throws for business refusals. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: "not-found" | "unauthenticated" | "invalid"; detail?: string };

export interface Driver {
  readonly kind: "inprocess" | "http";
  readonly fakes: Fakes;
  readonly recorder: Recorder;
  /** What this driver can do; scenarios that need more are skipped, not failed. */
  readonly capabilities: { recorder: boolean; reset: boolean };

  start(): Promise<void>;
  /** Called before every scenario. May return a short timing note. */
  reset(): Promise<string | void>;
  /** Called after every scenario: pull late records, etc. */
  settle(): Promise<void>;
  stop(): Promise<void>;
  diagnostics(): { mcpBuilds: string[] };

  // The protocol-level verbs the World composes. Named after what the system offers, not after endpoints.
  signIn(idToken: string): Promise<Outcome<Session>>;
  publish(session: Session, pack: PackSpec): Promise<Outcome<PackInfo>>;
  viewPack(session: Session | null, name: string): Promise<Outcome<PackInfo>>;
  downloadArchive(session: Session | null, name: string): Promise<Outcome<string>>;
  searchAsAgent(query: string): Promise<PackInfo[]>;
  searchOnSite(query: string): Promise<PackInfo[]>;
}

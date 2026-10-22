// Layer 2: the World. Scenarios speak only this vocabulary. It knows nothing
// about HTTP, SQL or bindings; it composes the driver's verbs and keeps handles
// (User, Pack, Agent) so a scenario can say `alice.publish(...)`, `bob.view(pack)`.
import type { Driver, Outcome, PackInfo, PackSpec, Session } from "../drivers/driver";
import type { Recorder } from "./recorder";

let runCounter = 0;
/** Functional isolation: every scenario gets unique names, so the same scenario can run repeatedly against one deployment. */
function alias(base: string): string {
  return `${base}-${Date.now().toString(36)}${(++runCounter).toString(36)}`;
}

export class Pack {
  constructor(readonly name: string, readonly spec: PackSpec) {}
  get visibility() {
    return this.spec.visibility;
  }
  get summary() {
    return this.spec.summary;
  }
}

export class User {
  private session: Session | null = null;
  constructor(readonly email: string, private readonly world: World) {}

  async signIn(): Promise<void> {
    const token = await this.world.driver.fakes.oidc.mintToken({ email: this.email });
    const r = await this.world.driver.signIn(token);
    if (!r.ok) throw new Error(`${this.email} could not sign in: ${r.refusal} ${r.detail ?? ""}`);
    this.session = r.value;
  }
  signOut(): void {
    this.session = null;
  }
  get isSignedIn(): boolean {
    return this.session !== null;
  }

  /** Publish a pack; business refusals come back as an Outcome, not an exception. */
  async publish(spec: PackSpec): Promise<Pack> {
    const r = await this.tryPublish(spec);
    if (!r.ok) throw new Error(`${this.email} could not publish ${spec.name}: ${r.refusal} ${r.detail ?? ""}`);
    return r.value;
  }
  async tryPublish(spec: PackSpec): Promise<Outcome<Pack>> {
    if (!this.session) return { ok: false, refusal: "unauthenticated" };
    const r = await this.world.driver.publish(this.session, spec);
    return r.ok ? { ok: true, value: this.world.packs.handle(spec) } : r;
  }
  view(pack: Pack): Promise<Outcome<PackInfo>> {
    return this.world.driver.viewPack(this.session, pack.name);
  }
  download(pack: Pack): Promise<Outcome<string>> {
    return this.world.driver.downloadArchive(this.session, pack.name);
  }
  /** The search box on the site. */
  async search(query: string): Promise<Pack[]> {
    return this.world.packs.fromResults(await this.world.driver.searchOnSite(query));
  }
}

/** An MCP client (an agent's tool call), with no account. */
export class Agent {
  constructor(private readonly world: World) {}
  async search(query: string): Promise<Pack[]> {
    return this.world.packs.fromResults(await this.world.driver.searchAsAgent(query));
  }
}

class Users {
  constructor(private readonly world: World) {}
  async create(opts: { name?: string } = {}): Promise<User> {
    return new User(`${alias(opts.name ?? "user")}@example.test`, this.world);
  }
}

class Packs {
  private readonly handles = new Map<string, Pack>();
  /** A valid pack with sensible defaults; name only what matters to the scenario. */
  sample(overrides: Partial<PackSpec> = {}): PackSpec {
    const name = overrides.name ?? alias("sample-pack");
    return { name, summary: `Sample pack ${name} for searching`, visibility: "public", archive: `tar-bytes-of-${name}`, ...overrides };
  }
  /** One Pack handle per name, so `expect(results).toContain(pack)` compares by identity. */
  handle(spec: PackSpec): Pack {
    let p = this.handles.get(spec.name);
    if (!p) this.handles.set(spec.name, (p = new Pack(spec.name, spec)));
    return p;
  }
  fromResults(results: PackInfo[]): Pack[] {
    return results.map((r) => this.handle({ name: r.name, summary: r.summary ?? "", visibility: r.visibility, archive: "" }));
  }
}

class Validation {
  constructor(private readonly world: World) {}
  /** Script what the validation LLM will say about the next pack. */
  willSay(verdict: "pass" | "flag" | "reject"): void {
    this.world.driver.fakes.llm.willAnswer(verdict);
  }
}

export class World {
  readonly users = new Users(this);
  readonly packs = new Packs();
  readonly validation = new Validation(this);
  constructor(readonly driver: Driver) {}
  agents = {
    anonymous: (): Agent => new Agent(this),
  };
  get recorder(): Recorder {
    return this.driver.recorder;
  }
  /** Flush late invocation records from the system before asserting on the recorder. */
  settle(): Promise<void> {
    return this.driver.settle();
  }
}

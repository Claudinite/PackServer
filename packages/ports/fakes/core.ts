import { sha256Hex } from "../src/hash";
import {
  PortError,
  type AuditEntry,
  type AuditSink,
  type Cache,
  type CacheEntry,
  type Clock,
  type D1,
  type D1Result,
  type DoArgs,
  type DoMethod,
  type DoNamespace,
  type DoResult,
  type DurableObjects,
  type KV,
  type Queue,
  type RateLimit,
  type R2,
  type Rng,
  type Stats,
  type TelemetryConfig,
  type StatsPoint,
  type Transparency,
  type Uploads,
  type Workflow,
} from "../src/ports";

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export class FakeClock implements Clock {
  constructor(private ms = Date.UTC(2026, 9, 22, 12, 0, 0)) {}
  now(): number {
    return this.ms;
  }
  advance(by: number | string): void {
    if (typeof by === "number") this.ms += by;
    else {
      const m = /^(\d+)(ms|s|m|h|d)$/.exec(by);
      if (!m) throw new Error(`not a duration: ${by}`);
      this.ms += Number(m[1]) * (UNITS[m[2] as string] as number);
    }
  }
}

/** Seeded (mulberry32) so a run's ids and floats repeat. */
export class FakeRng implements Rng {
  private state: number;
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }
  float(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => Math.floor(this.float() * 256));
  }
  uuid(): string {
    const h = [...this.bytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

export class FakeR2 implements R2 {
  readonly objects = new Map<string, { body: Uint8Array; content_type?: string }>();
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length } : null;
  }
  async put(key: string, body: Uint8Array, options?: { content_type?: string }) {
    this.objects.set(key, { body, ...(options?.content_type ? { content_type: options.content_type } : {}) });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export class FakeKV implements KV {
  readonly values = new Map<string, { value: string; expires_at: number | null }>();
  constructor(private readonly clock: Clock) {}
  private live(key: string) {
    const e = this.values.get(key);
    if (e && e.expires_at !== null && e.expires_at <= this.clock.now()) {
      this.values.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { ttl_seconds?: number }) {
    this.values.set(key, { value, expires_at: options?.ttl_seconds ? this.clock.now() + options.ttl_seconds * 1000 : null });
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list(prefix: string) {
    return [...this.values.keys()].filter((k) => k.startsWith(prefix) && this.live(k)).sort();
  }
}

export class FakeQueue implements Queue {
  readonly messages: unknown[] = [];
  async send(message: unknown) {
    this.messages.push(message);
  }
  async sendBatch(messages: unknown[]) {
    this.messages.push(...messages);
  }
}

/** Scripted: a handler per statement pattern, first match wins; an unscripted statement is an error, not an empty result. */
export class FakeD1 implements D1 {
  readonly executed: Array<{ sql: string; params: unknown[] }> = [];
  private readonly handlers: Array<{ pattern: RegExp; handle: (params: unknown[]) => Partial<D1Result> }> = [];
  on(pattern: RegExp, handle: (params: unknown[]) => Partial<D1Result>): this {
    this.handlers.push({ pattern, handle });
    return this;
  }
  async query(sql: string, params: unknown[] = []): Promise<D1Result> {
    this.executed.push({ sql, params });
    const h = this.handlers.find((x) => x.pattern.test(sql));
    if (!h) throw new PortError("unscripted", `FakeD1 has no handler for: ${sql}`);
    const r = h.handle(params);
    return { rows: r.rows ?? [], meta: r.meta ?? { changes: 0, last_row_id: null } };
  }
  async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
    const out: D1Result[] = [];
    for (const s of statements) out.push(await this.query(s.sql, s.params));
    return out;
  }
}

export class FakeDurableObjects implements DurableObjects {
  readonly calls: Array<{ namespace: string; name: string; method: string; args: unknown }> = [];
  private readonly objects = new Map<string, Record<string, (args: never) => unknown>>();
  register<D extends DoNamespace>(
    namespace: D,
    name: string,
    methods: { [M in DoMethod<D>]?: (...args: DoArgs<D, M>) => DoResult<D, M> },
  ): this {
    this.objects.set(`${namespace}/${name}`, Object.fromEntries(
      Object.entries(methods).map(([m, fn]) => [m, (args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args)]),
    ) as never);
    return this;
  }
  async call<D extends DoNamespace, M extends DoMethod<D>>(
    namespace: D,
    name: string,
    method: M,
    args: DoArgs<D, M>,
  ): Promise<DoResult<D, M>> {
    this.calls.push({ namespace, name, method, args });
    const fn = this.objects.get(`${namespace}/${name}`)?.[method];
    if (!fn) throw new PortError("unscripted", `no Durable Object method ${namespace}/${name}.${method}`);
    return (await fn(args as never)) as DoResult<D, M>;
  }
}

export class FakeWorkflow implements Workflow {
  readonly instances = new Map<string, { params: unknown; status: string }>();
  readonly events: Array<{ id: string; type: string; payload: unknown }> = [];
  async create(request: { id?: string; params: unknown }) {
    const id = request.id ?? `wf-${this.instances.size + 1}`;
    if (!this.instances.has(id)) this.instances.set(id, { params: request.params, status: "running" });
    return { id };
  }
  async status(id: string) {
    const i = this.instances.get(id);
    if (!i) throw new PortError("not_found", `no workflow instance ${id}`);
    return { status: i.status };
  }
  async sendEvent(id: string, event: { type: string; payload: unknown }) {
    if (!this.instances.has(id)) throw new PortError("not_found", `no workflow instance ${id}`);
    this.events.push({ id, ...event });
  }
}

/** Approximate like the real binding: refuses after `limit` calls for a key inside the period. */
export class FakeRateLimit implements RateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly clock: Clock,
    private readonly limitPerPeriod: number,
    private readonly periodMs: number,
  ) {}
  async limit(request: { key: string }) {
    const now = this.clock.now();
    const recent = (this.hits.get(request.key) ?? []).filter((t) => now - t < this.periodMs);
    const success = recent.length < this.limitPerPeriod;
    if (success) recent.push(now);
    this.hits.set(request.key, recent);
    return { success };
  }
}

export class FakeStats implements Stats {
  readonly points: StatsPoint[] = [];
  write(point: StatsPoint) {
    this.points.push(point);
  }
}

export class FakeTelemetryConfig implements TelemetryConfig {
  mode_: "normal" | "economy" = "normal";
  keys_: { ipMaster?: string; principalKey?: string } = { ipMaster: "fake-ip-hash-master", principalKey: "fake-principal-hash-key" };
  async keys() {
    return this.keys_;
  }
  async mode() {
    return this.mode_;
  }
}

export class FakeCache implements Cache {
  readonly entries = new Map<string, CacheEntry>();
  async get(url: string) {
    return this.entries.get(url) ?? null;
  }
  async put(url: string, entry: CacheEntry) {
    this.entries.set(url, entry);
  }
  async purge(url: string) {
    return this.entries.delete(url);
  }
}

export class FakeUploads implements Uploads {
  readonly objects = new Map<string, Uint8Array>();
  constructor(private readonly clock: Clock) {}
  async create(request: { key: string; max_bytes: number; content_type: string }) {
    return { key: request.key, url: `https://uploads.invalid/${request.key}?sig=fake`, expires_at: this.clock.now() + 900_000 };
  }
  /** What the client's direct PUT would do. */
  receive(key: string, body: Uint8Array) {
    this.objects.set(key, body);
  }
  async stat(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.length, sha256: await sha256Hex(o) } : null;
  }
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
}

const GENESIS = "0".repeat(64);

export class FakeAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async append(event: Record<string, unknown>) {
    const prev = this.entries.at(-1);
    const prev_hash = prev?.hash ?? GENESIS;
    const seq = (prev?.seq ?? -1) + 1;
    const hash = await sha256Hex(`${prev_hash}|${seq}|${JSON.stringify(event)}`);
    const entry = { seq, prev_hash, hash, event };
    this.entries.push(entry);
    return entry;
  }
  async head() {
    const e = this.entries.at(-1);
    return e ? { seq: e.seq, hash: e.hash } : null;
  }
  /** Recomputes the chain; false on any edit, reorder or removal. */
  async verify(): Promise<boolean> {
    let prev = GENESIS;
    for (const [i, e] of this.entries.entries()) {
      if (e.seq !== i || e.prev_hash !== prev) return false;
      if (e.hash !== (await sha256Hex(`${prev}|${e.seq}|${JSON.stringify(e.event)}`))) return false;
      prev = e.hash;
    }
    return true;
  }
}

export class FakeTransparency implements Transparency {
  readonly anchored: Array<{ seq: number; hash: string }> = [];
  async anchor(head: { seq: number; hash: string }) {
    this.anchored.push(head);
    return { log_index: this.anchored.length, anchored_hash: head.hash };
  }
}

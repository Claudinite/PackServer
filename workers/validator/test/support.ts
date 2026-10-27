import { migratedD1 } from "@packserver/core/identity/testing";
import { createSigner, encodePublicKey, toBase64Url } from "@packserver/core/index";
import { createFakePorts } from "@packserver/ports/fakes";
import type { ValidatorRuntime } from "../src/bindings";
import { REGISTRY_KEYS_FLAG } from "../src/sign/keys";

export const SEED = new Uint8Array(32).fill(5);
export const KID = "2026-10";

/** A validator runtime over the registry schema in SQLite and the fake ports; the key set is the one the seed belongs to. */
export async function testRuntime(o: { seed?: Uint8Array; withKeys?: boolean } = {}) {
  const { d1, db } = migratedD1();
  const fakes = createFakePorts({ worker: "validator" });
  const now = new Date(fakes.clock.now()).toISOString();
  if (o.withKeys !== false) {
    const keys = [{ kid: KID, public_key: await encodePublicKey(SEED), status: "active" }];
    db.prepare(`insert into feature_flags (key, value, security, updated_at) values (?, ?, 0, ?)`).run(REGISTRY_KEYS_FLAG, JSON.stringify(keys), now);
  }
  const seed = toBase64Url(o.seed ?? SEED);
  const rt = {
    ports: { ...fakes, d1 },
    services: {},
    config: { signingSeed: async () => seed, siteOrigin: () => "https://registry.example", rescanBatch: () => 50 },
  } as unknown as ValidatorRuntime;
  return { rt, db, fakes, publicBucket: fakes.r2.PACKS_PUBLIC!, privateBucket: fakes.r2.PACKS_PRIVATE!, signer: createSigner({ kid: KID, seed: SEED }) };
}

/** An org scope with one public pack and the given versions, as promotion leaves them. */
export function seedScope(db: ReturnType<typeof migratedD1>["db"], o: { scope?: string; pack?: string; visibility?: "public" | "private"; versions?: Array<{ version: string; state?: string; published_at?: string | null }> } = {}) {
  const scope = o.scope ?? "acme";
  const pack = o.pack ?? "gcp";
  db.exec(`insert or ignore into scopes (id, name, kind, state, created_at) values ('s-${scope}', '${scope}', 'org', 'active', 'x');
    insert into packs (id, scope_id, name, visibility, created_at) values ('p-${scope}-${pack}', 's-${scope}', '${pack}', '${o.visibility ?? "public"}', 'x');`);
  for (const v of o.versions ?? [{ version: "1.0.0" }]) {
    db.prepare(
      `insert into pack_versions (id, pack_id, version, state, sha256, size_bytes, published_at, verified, source_verified, min_engine_version, requires, preinstall)
       values (?, ?, ?, ?, ?, 10, ?, 0, 0, '1.0.0', '[]', '{"guards":[],"tasks":[],"forced_skills":[],"github_actions":[],"new":[]}')`,
    ).run(`v-${scope}-${pack}-${v.version}`, `p-${scope}-${pack}`, v.version, v.state ?? "active", "a".repeat(64), v.published_at === undefined ? "2026-10-22T12:00:00.000Z" : v.published_at);
  }
}

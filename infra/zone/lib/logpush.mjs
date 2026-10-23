// Logpush jobs into the environment's ops bucket, and the lifecycle rules that expire them.
import { ConfigError } from "../../lib/secrets-store.mjs";
import { suffixed } from "../../lib/plan.mjs";
import { same } from "./rulesets.mjs";
import { readTemplate, renderTransformer } from "./transformer.mjs";

export function readLogpushCredentials(envVars) {
  const accessKeyId = envVars.CF_LOGPUSH_R2_ACCESS_KEY_ID;
  const secretAccessKey = envVars.CF_LOGPUSH_R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new ConfigError("missing required environment: CF_LOGPUSH_R2_ACCESS_KEY_ID and CF_LOGPUSH_R2_SECRET_ACCESS_KEY (an R2 object write key for the ops bucket)");
  }
  return { accessKeyId, secretAccessKey };
}

const jobName = (env, key) => `packserver-${env}-${key}`;
const destinationBase = (accountId, bucket, prefix) => `r2://${bucket}/${prefix}?account-id=${accountId}`;
const destinationWithKey = (base, creds) =>
  `${base}&access-key-id=${encodeURIComponent(creds.accessKeyId)}&secret-access-key=${encodeURIComponent(creds.secretAccessKey)}`;

// A job has a filter or a transformer, never both: a transformer job carries its host and cache
// conditions in the SQL WHERE clause and an empty filter.
export function desiredJob({ job, env, hosts, accountId, bucket, creds, transformerId }) {
  const base = destinationBase(accountId, bucket, job.prefix);
  const body = {
    name: jobName(env, job.key),
    dataset: job.dataset,
    enabled: true,
    destination_conf: creds ? destinationWithKey(base, creds) : base,
  };
  if (job.transformer) {
    body.output_options = { output_type: "ndjson", timestamp_format: "rfc3339", sample_rate: job.sampleRate, "CVE-2021-44228": false };
    body.filter = "";
    body.transformer_id = transformerId;
  } else {
    body.output_options = { field_names: job.fields, timestamp_format: "rfc3339", sample_rate: job.sampleRate, "CVE-2021-44228": false };
    body.filter = JSON.stringify({ where: { and: [{ key: "ClientRequestHost", operator: "in", value: hosts }] } });
  }
  return { base, body };
}

// The destination's keys are redacted on read, so only the part before them is compared.
const summarise = (j) => ({
  dataset: j.dataset,
  enabled: j.enabled !== false,
  destination: (j.destination_conf ?? "").split("&access-key-id=")[0],
  fields: j.output_options?.field_names,
  sample_rate: j.output_options?.sample_rate ?? 1,
  filter: j.filter ? JSON.parse(j.filter) : null,
  transformer_id: j.transformer_id ?? null,
});

export const transformerName = (env, key) => `packserver-${env}-${key}`;

// 403 is its own state: the account lacks Transformers (or the token lacks Logs Write). It is not
// "absent", so nothing is created for the jobs that need one.
async function readTransformers(api, accountId) {
  try {
    const list = (await api("GET", `/accounts/${accountId}/logpush/transformers`)).result;
    if (!Array.isArray(list)) throw new Error("unrecognised transformer listing");
    return { byName: new Map(list.map((t) => [t.name, t])) };
  } catch (e) {
    if (e.status === 403) {
      return { forbidden: `TRANSFORMERS FORBIDDEN (403): ${e.message}. The account may lack Transformers or the token Logs Write; this is not read as "no transformers", and no http_requests job is created without one. D59 fallback: an HTTPS Logpush destination doing the same rewrite` };
    }
    throw e;
  }
}

// Runs the rendered SQL through the preview endpoint against every vector, and records that must be dropped.
export async function previewTransformer({ api, accountId, sql, job, hosts, spec }) {
  const { vectors, sampleRecord } = spec.logpush;
  const passing = { ...sampleRecord, CacheCacheStatus: job.previewCacheStatus, ClientRequestHost: hosts[0] };
  const run = async (input) => {
    const res = await api("POST", `/accounts/${accountId}/logpush/transformers/preview`, { sql, input });
    if (!Array.isArray(res.result)) throw new Error("unrecognised preview answer");
    return res.result;
  };
  for (const v of vectors) {
    const rows = await run({ ...passing, ClientIP: v.ip });
    if (rows.length !== 1) throw new Error(`preview of ${JSON.stringify(v.ip)} returned ${rows.length} records, expected 1`);
    const [row] = rows;
    if ("ClientIP" in row) throw new Error(`preview of ${JSON.stringify(v.ip)} still has ClientIP`);
    if (!("ClientNetwork" in row)) throw new Error(`preview of ${JSON.stringify(v.ip)} has no ClientNetwork`);
    if ((row.ClientNetwork ?? null) !== v.network) throw new Error(`preview of ${JSON.stringify(v.ip)} gave ClientNetwork ${JSON.stringify(row.ClientNetwork)}, expected ${JSON.stringify(v.network)}`);
    if (v.ip && Object.values(row).some((x) => typeof x === "string" && x.toLowerCase() === v.ip.toLowerCase())) throw new Error(`preview of ${JSON.stringify(v.ip)} carries the raw address in a field`);
  }
  const otherStatus = passing.CacheCacheStatus === "hit" ? "miss" : "hit";
  if ((await run({ ...passing, CacheCacheStatus: otherStatus, ClientIP: "198.51.100.7" })).length !== 0) throw new Error("preview kept a record of the other cache status");
  if ((await run({ ...passing, ClientRequestHost: "elsewhere.example.com", ClientIP: "198.51.100.7" })).length !== 0) throw new Error("preview kept a record of a host outside the environment");
}

export async function ensureLogpush({ api, accountId, zoneId, env, spec, hosts, creds, write, out, failures }) {
  const bucket = suffixed(env, spec.logpush.destinationBucket);
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      out(`FAILED ${label}: ${e.message}`);
      return undefined;
    }
  };

  // The jobs listing is not paginated; an unrecognised shape stops the section.
  let existing;
  try {
    const list = (await api("GET", `/zones/${zoneId}/logpush/jobs`)).result;
    if (!Array.isArray(list)) throw new Error("unrecognised Logpush listing");
    existing = new Map(list.map((j) => [j.name, j]));
  } catch (e) {
    failures.push(`logpush jobs: ${e.message}`);
    out(`FAILED logpush jobs: ${e.message}`);
    return;
  }
  let transformers;
  if (spec.logpush.jobs.some((j) => j.transformer)) {
    try {
      transformers = await readTransformers(api, accountId);
    } catch (e) {
      transformers = { error: e.message };
    }
  }
  for (const job of spec.logpush.jobs) {
    await attempt(`logpush ${jobName(env, job.key)}`, async () => {
      let transformerId;
      if (job.transformer) {
        if (transformers.forbidden) throw new Error(transformers.forbidden);
        if (transformers.error) throw new Error(`could not list transformers: ${transformers.error}`);
        const name = transformerName(env, job.key);
        const sql = renderTransformer(readTemplate(spec, job), job, hosts);
        await previewTransformer({ api, accountId, sql, job, hosts, spec });
        out(`ok       preview ${name}: ${spec.logpush.vectors.length} vectors give ClientNetwork and no ClientIP`);
        const have = transformers.byName.get(name);
        if (have) {
          const content = (await api("GET", `/accounts/${accountId}/logpush/transformers/${have.id}/content`)).result?.content;
          if (typeof content !== "string") throw new Error("unrecognised transformer content answer");
          transformerId = have.id;
          if (content.trimEnd() === sql) {
            out(`ok       transformer ${name}`);
          } else if (!write) {
            out(`would    update transformer ${name}`);
          } else {
            await api("PUT", `/accounts/${accountId}/logpush/transformers/${have.id}`, { name, code: sql });
            out(`updated  transformer ${name}`);
          }
        } else if (!write) {
          out(`would    create transformer ${name}`);
        } else {
          const made = (await api("POST", `/accounts/${accountId}/logpush/transformers`, { name, code: sql })).result;
          if (!Number.isInteger(made?.id)) throw new Error("create answered without a transformer id");
          transformerId = made.id;
          out(`created  transformer ${name}`);
        }
      }
      const want = desiredJob({ job, env, hosts, accountId, bucket, creds, transformerId });
      const have = existing.get(want.body.name);
      const known = !job.transformer || transformerId !== undefined;
      if (have && known && same(summarise(have), summarise(want.body))) {
        out(`ok       logpush ${want.body.name}`);
        return;
      }
      if (!write) {
        out(`would    ${have ? "update" : "create"} logpush ${want.body.name}`);
        return;
      }
      if (!creds) throw new Error("no R2 write key supplied");
      if (have) await api("PUT", `/zones/${zoneId}/logpush/jobs/${have.id}`, want.body);
      else await api("POST", `/zones/${zoneId}/logpush/jobs`, want.body);
      out(`${have ? "updated " : "created "} logpush ${want.body.name}`);
    });
  }

  await attempt(`lifecycle ${bucket}`, async () => {
    const path = `/accounts/${accountId}/r2/buckets/${bucket}/lifecycle`;
    const current = (await api("GET", path)).result;
    if (current?.rules !== undefined && !Array.isArray(current.rules)) throw new Error("unrecognised lifecycle listing");
    const rules = current?.rules ?? [];
    const ours = spec.logpush.retention.map((r) => ({
      id: `packserver-${r.prefix.replace(/\W+/g, "-").replace(/^-|-$/g, "")}`,
      enabled: true,
      conditions: { prefix: r.prefix },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: r.days * 86400 } },
    }));
    const ids = new Set(ours.map((r) => r.id));
    const others = rules.filter((r) => !ids.has(r.id));
    const mine = rules.filter((r) => ids.has(r.id)).map(({ id, enabled, conditions, deleteObjectsTransition }) => ({ id, enabled, conditions, deleteObjectsTransition }));
    if (same(mine.sort((a, b) => a.id.localeCompare(b.id)), [...ours].sort((a, b) => a.id.localeCompare(b.id)))) {
      out(`ok       lifecycle ${bucket}`);
      return;
    }
    if (!write) {
      out(`would    set lifecycle ${bucket}: ${spec.logpush.retention.map((r) => `${r.prefix} ${r.days}d`).join(", ")}`);
      return;
    }
    await api("PUT", path, { rules: [...others, ...ours] });
    out(`updated  lifecycle ${bucket}: ${spec.logpush.retention.map((r) => `${r.prefix} ${r.days}d`).join(", ")}`);
  });
}

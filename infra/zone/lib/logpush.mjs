// Logpush jobs into the environment's ops bucket, and the lifecycle rules that expire them.
import { ConfigError } from "../../lib/secrets-store.mjs";
import { suffixed } from "../../lib/plan.mjs";
import { same } from "./rulesets.mjs";

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

export function desiredJob({ job, env, hosts, accountId, bucket, creds }) {
  const conditions = [{ key: "ClientRequestHost", operator: "in", value: hosts }];
  if (job.where) conditions.push(job.where);
  const base = destinationBase(accountId, bucket, job.prefix);
  return {
    base,
    body: {
      name: jobName(env, job.key),
      dataset: job.dataset,
      enabled: true,
      destination_conf: creds ? destinationWithKey(base, creds) : base,
      output_options: { field_names: job.fields, timestamp_format: "rfc3339", sample_rate: job.sampleRate, "CVE-2021-44228": false },
      filter: JSON.stringify({ where: { and: conditions } }),
    },
  };
}

// The destination's keys are redacted on read, so only the part before them is compared.
const summarise = (j) => ({
  dataset: j.dataset,
  enabled: j.enabled !== false,
  destination: (j.destination_conf ?? "").split("&access-key-id=")[0],
  fields: j.output_options?.field_names,
  sample_rate: j.output_options?.sample_rate ?? 1,
  filter: j.filter ? JSON.parse(j.filter) : null,
});

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
  for (const job of spec.logpush.jobs) {
    await attempt(`logpush ${jobName(env, job.key)}`, async () => {
      const want = desiredJob({ job, env, hosts, accountId, bucket, creds });
      const have = existing.get(want.body.name);
      if (have && same(summarise(have), summarise(want.body))) {
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

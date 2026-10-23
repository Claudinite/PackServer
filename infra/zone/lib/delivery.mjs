// Reads back what Logpush actually delivered for the transformer jobs. Preview works on a
// hand-built record, so only a delivered object shows whether field_names and sampling interact
// with the transformer the way the SQL assumes.
import { gunzipSync } from "node:zlib";
import { URLSearchParams } from "node:url";
import { suffixed } from "../../lib/plan.mjs";

const API = "https://api.cloudflare.com/client/v4";
const NETWORK = /^([0-9]+\.[0-9]+\.[0-9]+\.0\/24|[0-9a-f:]+::\/48)$/;
const MAX_PAGES = 20;
const SAMPLE_RECORDS = 200;

export const VERIFIED = "verified";
export const PENDING = "pending";
export const FAILED = "failed";

async function listObjects(fetchImpl, token, accountId, bucket, prefix) {
  const objects = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ prefix, per_page: "1000", ...(cursor ? { cursor } : {}) });
    const res = await fetchImpl(`${API}/accounts/${accountId}/r2/buckets/${bucket}/objects?${q}`, { headers: { authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => undefined);
    if (!res.ok || json?.success === false || !Array.isArray(json?.result)) {
      throw new Error(`listing ${bucket}/${prefix} failed: HTTP ${res.status} ${(json?.errors ?? []).map((e) => e.message).join("; ")}`.trim());
    }
    objects.push(...json.result);
    if (!json.result_info?.is_truncated) return objects;
    cursor = json.result_info.cursor;
    if (!cursor) throw new Error(`listing ${bucket}/${prefix} is truncated without a cursor`);
  }
  throw new Error(`listing ${bucket}/${prefix} has more than ${MAX_PAGES} pages; cannot pick the latest object`);
}

async function readObject(fetchImpl, token, accountId, bucket, key) {
  const res = await fetchImpl(`${API}/accounts/${accountId}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`reading ${bucket}/${key} failed: HTTP ${res.status}`);
  let bytes = Buffer.from(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return bytes.toString("utf8");
}

export function assessRecords(job, text, required) {
  const rows = text.split("\n").filter(Boolean).slice(0, SAMPLE_RECORDS).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`line ${i + 1} is not JSON; the job must deliver ndjson`);
    }
  });
  if (rows.length === 0) throw new Error("the object holds no records");
  const problems = [];
  const bad = (what, n) => n && problems.push(`${what} in ${n} of ${rows.length} records`);
  bad("ClientIP present", rows.filter((r) => "ClientIP" in r).length);
  bad("ClientNetwork missing or not network-shaped", rows.filter((r) => typeof r.ClientNetwork !== "string" || !NETWORK.test(r.ClientNetwork)).length);
  for (const f of required) bad(`${f} null or missing`, rows.filter((r) => r[f] == null).length);
  if (job.previewCacheStatus === "hit") bad("CacheCacheStatus other than hit", rows.filter((r) => r.CacheCacheStatus !== "hit").length);
  if (job.previewCacheStatus === "miss") bad("CacheCacheStatus hit", rows.filter((r) => r.CacheCacheStatus === "hit").length);
  if (problems.length) throw new Error(problems.join("; "));
  return rows.length;
}

// One pass over every transformer job. `since` (ms) ignores objects delivered before a change.
export async function checkDeliveryOnce({ fetchImpl, token, accountId, env, spec, since }) {
  const bucket = suffixed(env, spec.logpush.destinationBucket);
  const results = [];
  for (const job of spec.logpush.jobs.filter((j) => j.transformer)) {
    const prefix = job.prefix.split("{DATE}")[0];
    const label = `packserver-${env}-${job.key}`;
    try {
      const fresh = (await listObjects(fetchImpl, token, accountId, bucket, prefix)).filter((o) => since === undefined || Date.parse(o.last_modified) >= since);
      if (fresh.length === 0) {
        results.push({ job: label, state: PENDING, detail: `no object under ${bucket}/${prefix}${since === undefined ? "" : " since the change"} yet` });
        continue;
      }
      const latest = fresh.reduce((a, b) => (Date.parse(b.last_modified) > Date.parse(a.last_modified) ? b : a));
      const n = assessRecords(job, await readObject(fetchImpl, token, accountId, bucket, latest.key), spec.logpush.deliveryRequiredFields);
      results.push({ job: label, state: VERIFIED, detail: `${latest.key}: ${n} records, ClientNetwork present, no ClientIP, ${spec.logpush.deliveryRequiredFields.join(", ")} non-null` });
    } catch (e) {
      results.push({ job: label, state: FAILED, detail: e.message });
    }
  }
  return results;
}

// Polls until every job has left "pending" or the wait is spent. A job still pending at the end
// stays pending: not delivered is never a pass.
export async function verifyDelivery({ waitMs, intervalMs = 15000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, out, ...args }) {
  const deadline = now() + waitMs;
  for (;;) {
    const results = await checkDeliveryOnce(args);
    const pending = results.filter((r) => r.state === PENDING);
    if (pending.length === 0 || now() >= deadline) {
      for (const r of results) out(`${r.state.padEnd(8)} delivery ${r.job}: ${r.detail}`);
      for (const r of pending) out(`not yet delivered: ${r.job} is NOT verified; re-run with --verify-delivery once traffic has produced an object`);
      return results;
    }
    await sleep(intervalMs);
  }
}

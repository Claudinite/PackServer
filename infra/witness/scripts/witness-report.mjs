#!/usr/bin/env node
// Runs in Claudinite/packserver-witness after each Upptime probe cycle. It turns Upptime's open
// downtime issues and the judge's heartbeat into the signed reports the alert router accepts at
// /hooks/witness, and pushes to Pushover directly when the router cannot be reached. It depends on
// nothing outside Node, so the repository needs no install step.
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

export const HOOK_URL = "https://registry.claudinite.com/hooks/witness";
export const OPS_PAGE_URL = "https://registry-admin.claudinite.com/admin/ops";
export const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
export const SITE_SLUGS = ["registry", "index-root", "oauth-metadata"];
export const PROBE_INTERVAL_MS = 5 * 60_000;
export const HEARTBEAT_SIGNAL = "monitoring.heartbeat";
// Matches the router's `page.monitoring_dead`: no heartbeat for 15 minutes.
export const HEARTBEAT_MAX_AGE_MS = 15 * 60_000;

/** Fixed-format signature the router verifies: `t=<ms>,v1=<hex hmac-sha256 of "<ms>.<body>">`. */
export function signReport(secret, body, nowMs) {
  return `t=${nowMs},v1=${createHmac("sha256", secret).update(`${nowMs}.${body}`).digest("hex")}`;
}

/**
 * The longest run of failed probes among the sites, from Upptime's open downtime issues (label
 * `status` plus the site's slug, title starting with the down marker). Upptime opens the issue in
 * the cycle that confirms the failure, so its age in probe intervals counts the cycles since.
 */
export function siteFailures(issues, nowMs) {
  let consecutive = 0;
  const down = [];
  for (const issue of issues) {
    if (!issue.title.startsWith("\u{1F6D1}")) continue;
    const slug = issue.labels.map((l) => (typeof l === "string" ? l : l.name)).find((n) => SITE_SLUGS.includes(n));
    if (!slug) continue;
    const age = Math.max(0, nowMs - Date.parse(issue.created_at));
    down.push(slug);
    consecutive = Math.max(consecutive, Math.round(age / PROBE_INTERVAL_MS) + 1);
  }
  return { down, consecutive };
}

export function heartbeatSql(nowMs) {
  const at = (ms) => Math.floor((nowMs - ms) / 1000);
  return `SELECT sumIf(_sample_interval, timestamp >= toDateTime(${at(HEARTBEAT_MAX_AGE_MS)})) AS fresh FROM domain_events WHERE index1 = '${HEARTBEAT_SIGNAL}' AND timestamp >= toDateTime(${at(HEARTBEAT_MAX_AGE_MS)}) FORMAT JSON`;
}

/** A thrown answer means the heartbeat could not be checked; only a real zero count is a dead judge. */
export function heartbeatState(response) {
  const row = response?.data?.[0];
  const fresh = row === undefined ? Number.NaN : Number(row.fresh);
  if (!Number.isFinite(fresh)) throw new Error("the heartbeat query answered with no usable row");
  return { alive: fresh > 0 };
}

const STATE_LABEL = "witness-push";
const PUSH_REPEAT_MS = 60 * 60_000;

async function ok(response, what) {
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return response;
}

const githubHeaders = (env) => ({ authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "packserver-witness" });
const repoApi = (env) => `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;

export async function listOpenStatusIssues({ env, fetchImpl }) {
  const response = await ok(await fetchImpl(`${repoApi(env)}/issues?state=open&labels=status&per_page=100`, { headers: githubHeaders(env) }), "GitHub issues");
  return (await response.json()).filter((i) => !i.pull_request);
}

/**
 * Direct pushes are throttled on a record kept in the repository itself: one issue per push kind,
 * commented on at each push, so its last update is the last push whatever happened to the runs between.
 */
async function pushState(kind, { env, fetchImpl }) {
  const response = await ok(await fetchImpl(`${repoApi(env)}/issues?state=open&labels=${STATE_LABEL}&per_page=100`, { headers: githubHeaders(env) }), "GitHub push records");
  const issue = (await response.json()).find((i) => !i.pull_request && i.title === kind);
  return issue ? { number: issue.number, lastPushMs: Date.parse(issue.updated_at) } : null;
}

async function recordPush(kind, state, nowMs, { env, fetchImpl }) {
  const headers = { ...githubHeaders(env), "content-type": "application/json" };
  const at = new Date(nowMs).toISOString();
  const [url, body] = state
    ? [`${repoApi(env)}/issues/${state.number}/comments`, { body: `Pushed ${at}` }]
    : [`${repoApi(env)}/issues`, { title: kind, body: `Direct Pushover pushes of this kind are recorded here to throttle them. First: ${at}`, labels: [STATE_LABEL] }];
  await ok(await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) }), "GitHub push record");
}

export async function readHeartbeat({ env, fetchImpl, nowMs }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const response = await ok(await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${env.CF_ANALYTICS_READ_TOKEN}` }, body: heartbeatSql(nowMs) }), "Analytics Engine SQL");
  return heartbeatState(await response.json());
}

export async function postToRouter(report, { env, fetchImpl, nowMs }) {
  const body = JSON.stringify(report);
  const response = await fetchImpl(HOOK_URL, { method: "POST", headers: { "content-type": "application/json", "x-witness-signature": signReport(env.WITNESS_HOOK_SECRET, body, nowMs) }, body });
  return response.ok;
}

async function pushover({ title, message }, { env, fetchImpl }) {
  const body = new URLSearchParams({ token: env.PUSHOVER_APP_TOKEN, user: env.PUSHOVER_USER_KEY, title, message, priority: "1", url: OPS_PAGE_URL, url_title: "Ops page" });
  await ok(await fetchImpl(PUSHOVER_URL, { method: "POST", body }), "Pushover");
}

/** Pushes at most once an hour per kind, counted from the last recorded push. */
export async function pushDirect(kind, text, ctx, log) {
  const state = await pushState(kind, ctx);
  if (state && ctx.nowMs - state.lastPushMs < PUSH_REPEAT_MS) {
    log(`${kind}: direct push held back, one was sent within the hour`);
    return;
  }
  await pushover(text, ctx);
  log(`${kind}: pushed to Pushover directly`);
  await recordPush(kind, state, ctx.nowMs, ctx);
}

/** Delivers one down report through the router, falling back to Pushover when the router does not accept it. */
async function deliver(report, text, ctx, log, pushable = true) {
  let accepted = false;
  try {
    accepted = await postToRouter(report, ctx);
  } catch (error) {
    log(`router unreachable: ${error.message}`);
  }
  log(`${report.check} down: router ${accepted ? "accepted" : "did not accept"} the report`);
  if (!accepted && pushable) await pushDirect(report.check, text, ctx, log);
}

export async function run({ env, fetchImpl = fetch, nowMs = Date.now(), log = console.log }) {
  const ctx = { env, fetchImpl, nowMs };
  const failures = [];

  try {
    const { down, consecutive } = siteFailures(await listOpenStatusIssues(ctx), nowMs);
    log(`sites down: ${down.length === 0 ? "none" : down.join(", ")}`);
    if (down.length > 0) {
      await deliver({ check: "site", status: "down", consecutive_failures: consecutive }, { title: "Witness: registry unreachable", message: `${down.join(", ")} failed ${consecutive} probe(s) in a row.` }, ctx, log, consecutive >= 2);
    }
  } catch (error) {
    failures.push(`site check: ${error.message}`);
  }

  try {
    const { alive } = await readHeartbeat(ctx);
    log(`judge heartbeat: ${alive ? "alive" : "missing"}`);
    if (!alive) {
      await deliver({ check: "judge_heartbeat", status: "down" }, { title: "Witness: judge heartbeat missing", message: "No judge heartbeat for 15 minutes." }, ctx, log);
    }
  } catch (error) {
    failures.push(`heartbeat check: ${error.message}`);
    try {
      await pushDirect("judge_unchecked", { title: "Witness cannot check the judge", message: "The witness could not read the judge heartbeat (token, query or account problem). This is not a report that the judge is down." }, ctx, log);
    } catch (pushError) {
      failures.push(`unchecked notice: ${pushError.message}`);
    }
  }

  for (const failure of failures) log(`could not complete: ${failure}`);
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const failures = await run({ env: process.env });
  process.exitCode = failures.length === 0 ? 0 : 1;
}

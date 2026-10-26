// The ci-performance code_work: measure, record, and hand off only if something moved.
//
// The measurement is the Actions run ledger — the same source the
// ci-performance-evaluation skill's first step names, and the only account of CI
// duration that is not somebody's impression. Per workflow, the MEDIAN duration
// over the last window against the median over the window before it. Median rather
// than mean because a single queued or retried run doubles a mean and says nothing
// about the suite.
//
// The verdict logic is pure and exported (`summarize`), so what counts as a
// regression is decided in one place and tested there rather than inferred from a
// live repo's weather.

import { github, log } from '@claudinite/sdk';
import { makeGh } from './github-api.mjs';

export const WINDOW_DAYS = 7;
// A regression has to clear BOTH bars. The ratio alone fires on a fast workflow
// where a few seconds of runner weather is a large fraction; the absolute alone
// fires on a long workflow whose normal spread is wider than the threshold.
export const REGRESSION_RATIO = 1.25;
export const REGRESSION_SECONDS = 20;
// Below this, a median is one or two runs and describes the week's luck rather than
// the suite. Such a workflow is reported, never judged.
export const MIN_RUNS_PER_WINDOW = 3;

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Seconds a completed run took. `run_started_at` rather than `created_at`: the gap
// between them is queue time, which is the runner pool's business and moves for
// reasons no change to this repo can fix.
export function runSeconds(run) {
  const start = Date.parse(run.run_started_at || run.created_at);
  const end = Date.parse(run.updated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

/**
 * Per-workflow medians for the current and previous window, and the regressions
 * among them. Pure — `runs` is the API's records, `nowMs` the reference instant.
 * A run outside both windows, still in progress, or unparseable is dropped.
 */
export function summarize(runs, nowMs, { windowDays = WINDOW_DAYS } = {}) {
  const windowMs = windowDays * 86400 * 1000;
  const byWorkflow = new Map();
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    const seconds = runSeconds(run);
    if (seconds === null) continue;
    const age = nowMs - Date.parse(run.run_started_at || run.created_at);
    const bucket = age < 0 || age > 2 * windowMs ? null : age <= windowMs ? 'current' : 'previous';
    if (!bucket) continue;
    const name = run.name || run.path || 'unnamed';
    if (!byWorkflow.has(name)) byWorkflow.set(name, { name, current: [], previous: [] });
    byWorkflow.get(name)[bucket].push(seconds);
  }

  const workflows = [...byWorkflow.values()].map((w) => {
    const current = median(w.current);
    const previous = median(w.previous);
    // "Comparable" is a property of the data, and it is reported: a workflow with
    // too few runs to judge must not read as a workflow that was judged and cleared.
    const comparable = w.current.length >= MIN_RUNS_PER_WINDOW && w.previous.length >= MIN_RUNS_PER_WINDOW;
    const regressed = comparable
      && current >= previous * REGRESSION_RATIO
      && current - previous >= REGRESSION_SECONDS;
    return { ...w, runs: w.current.length, priorRuns: w.previous.length, current, previous, comparable, regressed };
  }).sort((a, b) => (b.current ?? 0) - (a.current ?? 0));

  return { workflows, regressions: workflows.filter((w) => w.regressed) };
}

// The slowest step of one run, for the report — the skill's step 1 ("take the step
// breakdown before forming any theory"), pre-taken so the agent starts from the
// breakdown rather than spending its first calls fetching it.
export function slowestSteps(job, limit = 3) {
  return (job?.steps ?? [])
    .map((s) => {
      const start = Date.parse(s.started_at);
      const end = Date.parse(s.completed_at);
      return Number.isFinite(start) && Number.isFinite(end)
        ? { name: s.name, seconds: Math.round((end - start) / 1000) }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

const fmt = (s) => (s === null ? '—' : `${s}s`);

export function reportBody(summary, { repo, nowIso, steps = [] }) {
  const rows = summary.workflows.map((w) => {
    const delta = w.comparable && w.current !== null && w.previous !== null
      ? `${w.current - w.previous >= 0 ? '+' : ''}${w.current - w.previous}s`
      : '—';
    const verdict = w.regressed ? '**regressed**' : w.comparable ? 'steady' : `too few runs (${w.runs} / ${w.priorRuns})`;
    return `| \`${w.name}\` | ${fmt(w.current)} | ${fmt(w.previous)} | ${delta} | ${verdict} |`;
  });
  const stepLines = steps.length
    ? ['', 'Slowest steps of the most recent run of the slowest workflow:', '',
      ...steps.map((s) => `- ${s.name} — ${s.seconds}s`)]
    : [];
  return [
    `CI duration for \`${repo}\`, median per workflow over the last ${WINDOW_DAYS} days against the ${WINDOW_DAYS} before.`,
    `Rewritten by the \`ci-performance\` task on each run — last ${nowIso}.`,
    '',
    '| Workflow | This window | Previous | Delta | |',
    '|---|---|---|---|---|',
    ...(rows.length ? rows : ['| _no completed runs in either window_ | — | — | — | — |']),
    ...stepLines,
    '',
    `A workflow is called regressed only when its median is both ≥${REGRESSION_RATIO}x and ≥${REGRESSION_SECONDS}s above the previous window, with at least ${MIN_RUNS_PER_WINDOW} runs in each — otherwise a quiet week or one requeued run reads as a regression.`,
    '',
    'Method: the `ci-performance-evaluation` skill.',
  ].join('\n');
}

// The standing record this task keeps. Its own, named here and nowhere else.
export const TRACKER_TITLE = '[claudinite] CI performance';

// The API caps a filtered listing at 1000 results.
const LEDGER_PAGE_SIZE = 100;
const LEDGER_MAX_PAGES = 10;

// Every completed run started inside both windows. A single repo-wide page reaches back
// only as far as the busiest workflow lets it, so a quiet workflow's previous window
// would be judged on whatever few runs that page happened to hold.
export async function readWindowRuns(repo, gh, nowMs) {
  const since = new Date(nowMs - 2 * WINDOW_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const runs = [];
  for (let page = 1; page <= LEDGER_MAX_PAGES; page++) {
    const { status, json } = await gh(
      `/repos/${repo}/actions/runs?status=completed&created=${encodeURIComponent(`>=${since}`)}&per_page=${LEDGER_PAGE_SIZE}&page=${page}`,
    );
    if (status !== 200) throw new Error(`run ledger unreadable: GET actions/runs returned ${status}`);
    const batch = json?.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < LEDGER_PAGE_SIZE) break;
  }
  return runs;
}

// The run ledger and a run's jobs have no SDK action; the tracker does.
export async function worker({ repo }, gh = makeGh(), nowMs = Date.now()) {
  const runs = await readWindowRuns(repo, gh, nowMs);
  const summary = summarize(runs, nowMs);

  // The step breakdown of the slowest workflow's latest run — one extra read, and
  // the thing any investigation would fetch first anyway.
  let steps = [];
  const slowest = summary.workflows[0];
  if (slowest) {
    const latest = runs.find((r) => (r.name || r.path) === slowest.name);
    if (latest) {
      const jobs = await gh(`/repos/${repo}/actions/runs/${latest.id}/jobs`);
      steps = slowestSteps(jobs.json?.jobs?.[0]);
    }
  }

  const nowIso = new Date(nowMs).toISOString();
  const body = reportBody(summary, { repo, nowIso, steps });
  for (const w of summary.workflows) {
    log(`${w.name}: ${fmt(w.current)} (was ${fmt(w.previous)})${w.regressed ? ' — REGRESSED' : ''}`);
  }

  const detail = summary.regressions
    .map((w) => `\`${w.name}\` ${w.previous}s → ${w.current}s`)
    .join('; ');
  const comment = summary.regressions.length
    ? `${nowIso} — regression: ${detail}. Investigating by the \`ci-performance-evaluation\` skill.`
    : null;
  // THIS TASK's tracker, resolved by this task — the engine's tracker actions own only
  // the exact-title lookup and the create-then-close pair, never the decision to keep
  // one. Every run rewrites the body (the measurement IS the record), so
  // find-or-create is right here; the comment is conditional, because a dated note
  // per run turns a standing record into a scroll of identical lines nobody reads.
  const { number: tracker } = await github.findOrCreateTracker({ title: TRACKER_TITLE });
  await github.writeTracker({ number: tracker, body, ...(comment ? { comment } : {}) });
  log(`tracker #${tracker} refreshed`);

  if (!summary.regressions.length) {
    log('no workflow regressed this window — record refreshed, no agent needed');
    return;
  }

  log(`agent requested - ${detail}`);
  // The number reaches the agentic phase the ordinary way: the hand-off payload's
  // `delivered`, which the dispatch renders as an `Issue:` line. Nothing else in
  // this run's life carries it.
  return {
    requestAgent: {
      delivered: { issue: tracker },
      reason: { code: 'ci-duration-regression', detail },
    },
  };
}

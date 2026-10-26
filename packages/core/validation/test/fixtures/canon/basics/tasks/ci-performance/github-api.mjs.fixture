// The REST calls this pack's worker makes that @claudinite/sdk names no action for.
// The SDK's `github` actions are the way a worker reaches GitHub, granted per pack and
// logged by the engine; a call outside them reads the job's own token, which the
// executor leaves in every work step's environment, and nothing else. Each one here
// moves to its SDK action once the engine offers it.
//
// `gh(path)` reads and `gh(path, { method, body })` writes, answering
// `{ status, json }`: a non-2xx is an answer rather than a throw, so a caller judges
// the status before trusting the body.

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

export function makeGh({ token = process.env.GITHUB_TOKEN, api = API, fetchImpl = fetch } = {}) {
  return async function gh(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'user-agent': 'claudinite-task',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
}

export interface Fetching {
  fetch: typeof fetch;
  registry: string;
  /** Sent on every request so one run's calls reach one Worker version where the host honours it. */
  versionKey?: string;
}

export class RegistryError extends Error {
  constructor(readonly step: string, readonly status: number, readonly reason: string | null, message: string) {
    super(`${step}: ${message} (HTTP ${status}${reason ? `, ${reason}` : ""})`);
  }
}

async function failure(step: string, response: Response): Promise<RegistryError> {
  const body = (await response.json().catch(() => null)) as { reason?: string; error?: string; message?: string } | null;
  return new RegistryError(step, response.status, body?.reason ?? body?.error ?? null, body?.message ?? "refused");
}

async function call<T>(io: Fetching, step: string, path: string, init: { method: string; bearer?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { "user-agent": "claudinite-publish-pack" };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (io.versionKey) headers["cloudflare-workers-version-key"] = io.versionKey;
  const response = await io.fetch(new URL(path, io.registry), { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (!response.ok) throw await failure(step, response);
  return (await response.json()) as T;
}

export interface Credential {
  credential: string;
  expires_at: string;
}

export const exchange = (io: Fetching, input: { token: string; pack: string; version: string; job: string | undefined }) =>
  call<Credential>(io, "exchange", "/api/oidc/exchange", { method: "POST", body: { token: input.token, pack: input.pack, version: input.version, ...(input.job ? { job: input.job } : {}) } });

export interface Presigned {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

const packPath = (pack: string, version: string) => `/api/publish/${pack}/${version}`;

export const presign = (io: Fetching, credential: string, pack: string, version: string, contentLength: number) =>
  call<Presigned>(io, "upload-url", `${packPath(pack, version)}/upload-url`, { method: "POST", bearer: credential, body: { content_length: contentLength } });

/** The one PUT goes straight to the storage host, which is not the registry, so it carries neither the credential nor the version key. */
export async function put(io: Fetching, target: Presigned, archive: Uint8Array): Promise<void> {
  const response = await io.fetch(target.url, { method: "PUT", headers: target.headers, body: archive });
  if (!response.ok) throw new RegistryError("upload", response.status, null, "the storage host refused the archive");
}

export const confirmUploaded = (io: Fetching, credential: string, pack: string, version: string) =>
  call<{ size_bytes: number }>(io, "uploaded", `${packPath(pack, version)}/uploaded`, { method: "POST", bearer: credential });

export interface RunView {
  run_id: string;
  status: "queued" | "running" | "finished";
  verdict: "pass" | "warn" | "hold" | "fail" | "error" | null;
  reason: string | null;
  milestones: { step: string; outcome: string; detail?: string }[];
}

export const start = (io: Fetching, credential: string, pack: string, version: string, sha256: string) =>
  call<RunView>(io, "publish", packPath(pack, version), { method: "POST", bearer: credential, body: { sha256 } });

export const runStatus = (io: Fetching, credential: string, runId: string) =>
  call<RunView>(io, "run status", `/api/publish/runs/${runId}`, { method: "GET", bearer: credential });

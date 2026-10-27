import { VERSION_HEADER } from "@packserver/http";
import type { ApiResponse } from "./driver";
import { releaseProblem } from "./http/runtime-neutral";
import { InfrastructureError } from "../world/errors";

/** Every response names the release that produced it (REQ-OPS-006); a driver checks it on each one. */
export class VersionObserver {
  private readonly seen = new Set<string>();
  constructor(private readonly expected: ReadonlySet<string> | null) {}

  check(url: string, res: ApiResponse): void {
    const release = res.headers.get(VERSION_HEADER);
    const problem = releaseProblem(this.expected, url, res.status, release);
    if (release) this.seen.add(release);
    if (problem) throw new InfrastructureError(problem);
  }

  clear(): void {
    this.seen.clear();
  }

  get observed(): ReadonlySet<string> {
    return this.seen;
  }
}

export async function toApiResponse(res: Response): Promise<ApiResponse> {
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) as unknown };
}

export function encodeBody(body: unknown, headers: Record<string, string>): string | Uint8Array<ArrayBuffer> | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body as string | Uint8Array<ArrayBuffer>;
  headers["content-type"] ??= "application/json";
  return JSON.stringify(body);
}

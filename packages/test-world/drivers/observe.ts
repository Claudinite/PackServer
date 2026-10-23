import { VERSION_HEADER } from "@packserver/http";
import type { ApiResponse } from "./driver";
import { InfrastructureError } from "../world/errors";

/** Every response names the release that produced it (REQ-OPS-006); a driver checks it on each one. */
export class VersionObserver {
  private readonly seen = new Set<string>();
  constructor(private readonly expected: ReadonlySet<string> | null) {}

  check(url: string, res: ApiResponse): void {
    const release = res.headers.get(VERSION_HEADER);
    if (!release) throw new InfrastructureError(`${url} answered ${res.status} without ${VERSION_HEADER}`);
    this.seen.add(release);
    if (this.expected && !this.expected.has(release)) {
      throw new InfrastructureError(`${url} answered with ${VERSION_HEADER} ${release}, expected ${[...this.expected].join(" or ")}`);
    }
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

export const RELEASE_HEADER = "X-PackServer-Release";

export type ReleaseAcceptance =
  | { ok: true; relation: "same" | "previous" | "next" }
  | { ok: false; reason: "missing" | "unknown_release" | "out_of_window" };

/**
 * N/N-1 on service bindings: a callee accepts a caller from its own release or the
 * release just before or after it. `releases` is the release manifest, oldest first.
 */
export function acceptRelease(
  own: string,
  peer: string | null | undefined,
  releases: readonly string[],
): ReleaseAcceptance {
  if (peer === null || peer === undefined || peer === "") return { ok: false, reason: "missing" };
  const ownIndex = releases.indexOf(own);
  const peerIndex = releases.indexOf(peer);
  if (ownIndex < 0 || peerIndex < 0) return { ok: false, reason: "unknown_release" };
  const delta = peerIndex - ownIndex;
  if (delta === 0) return { ok: true, relation: "same" };
  if (delta === -1) return { ok: true, relation: "previous" };
  if (delta === 1) return { ok: true, relation: "next" };
  return { ok: false, reason: "out_of_window" };
}

export function readReleaseHeader(headers: Headers): string | null {
  return headers.get(RELEASE_HEADER);
}

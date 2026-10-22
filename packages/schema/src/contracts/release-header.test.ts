import { describe, expect, it } from "vitest";
import { RELEASE_HEADER, acceptRelease, readReleaseHeader } from "./release-header";

const releases = ["r1", "r2", "r3", "r4"];

describe("X-PackServer-Release N/N-1", () => {
  it("accepts the same, previous and next release", () => {
    expect(acceptRelease("r2", "r2", releases)).toEqual({ ok: true, relation: "same" });
    expect(acceptRelease("r2", "r1", releases)).toEqual({ ok: true, relation: "previous" });
    expect(acceptRelease("r2", "r3", releases)).toEqual({ ok: true, relation: "next" });
  });
  it("refuses a peer two releases away in either direction", () => {
    expect(acceptRelease("r3", "r1", releases)).toEqual({ ok: false, reason: "out_of_window" });
    expect(acceptRelease("r1", "r3", releases)).toEqual({ ok: false, reason: "out_of_window" });
  });
  it("refuses a missing header and a release the manifest does not know", () => {
    expect(acceptRelease("r2", null, releases)).toEqual({ ok: false, reason: "missing" });
    expect(acceptRelease("r2", "", releases)).toEqual({ ok: false, reason: "missing" });
    expect(acceptRelease("r2", "rX", releases)).toEqual({ ok: false, reason: "unknown_release" });
    expect(acceptRelease("rX", "r2", releases)).toEqual({ ok: false, reason: "unknown_release" });
  });
  it("reads the header case-insensitively", () => {
    expect(readReleaseHeader(new Headers({ [RELEASE_HEADER.toLowerCase()]: "r2" }))).toBe("r2");
    expect(readReleaseHeader(new Headers())).toBeNull();
  });
});

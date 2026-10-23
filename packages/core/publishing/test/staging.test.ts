import { describe, expect, it } from "vitest";
import { fitsStagingCap, MAX_UPLOAD_BYTES, objectExpiry, STAGING_LIFECYCLE_RULES, STAGING_PREFIX_CAP_BYTES, stagingKey, stagingPrefix } from "../staging";

const MiB = 1024 * 1024;

describe("staging", () => {
  it("names the object by its credential, under the scope's prefix", () => {
    expect(stagingKey("acme", "gcp", "1.0.0", "c1")).toBe("staging/acme/gcp/1.0.0/c1.tar.zst");
    expect(stagingKey("acme", "gcp", "1.0.0", "c1").startsWith(stagingPrefix("acme"))).toBe(true);
  });
  it("caps one object at 3 MiB and a scope's prefix at 50 MiB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(3 * MiB);
    expect(STAGING_PREFIX_CAP_BYTES).toBe(50 * MiB);
    expect(fitsStagingCap(47 * MiB, 3 * MiB)).toBe(true);
    expect(fitsStagingCap(49 * MiB, 2 * MiB)).toBe(false);
  });
  it("lets a bare dry-run wait an hour and a draft fourteen days", () => {
    expect(objectExpiry(0, "dry-run")).toBe(3_600_000);
    expect(objectExpiry(0, "draft")).toBe(14 * 86_400_000);
  });
  it("aborts incomplete multipart uploads after one day", () => {
    expect(STAGING_LIFECYCLE_RULES[0].abortMultipartUploadsTransition.condition).toEqual({ type: "Age", maxAge: 86_400 });
  });
});

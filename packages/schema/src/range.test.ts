import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../test/migrated-db";
import { SCHEMA_MAX, SCHEMA_MIN } from "./range";

describe("IT-OPS-011 schema range", () => {
  const stamps = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => f.split("_")[0]);

  it("ends at the newest migration", () => {
    expect(SCHEMA_MAX).toBe(stamps.at(-1));
  });

  it("starts at a migration that exists and is not past the head", () => {
    expect(stamps).toContain(SCHEMA_MIN);
    expect(SCHEMA_MIN <= SCHEMA_MAX).toBe(true);
  });
});

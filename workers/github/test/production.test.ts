import { ProductionConfigError } from "@packserver/core/synthetic";
import { dummyEnv } from "@packserver/http/testing";
import { describe, expect, it } from "vitest";
import { createRuntime, type Env } from "../src/bindings";

const REAL = "9f2c41d07be34a1c8e5d62f0a7b3c918";
const STAND_IN = "whsec_test_00000000000000000000000000000000";
const build = (environment: string, secret: unknown) => createRuntime({ ...dummyEnv("github", environment), GITHUB_WEBHOOK_SECRET: secret } as unknown as Env);

describe("REQ-OPS-003: the github Worker refuses a test webhook secret outside the test environment", () => {
  for (const environment of ["staging", "production"]) {
    it(`at startup, when it is bound as plain text in ${environment}`, () => {
      expect(() => build(environment, STAND_IN)).toThrow(ProductionConfigError);
      expect(() => build(environment, REAL)).not.toThrow();
    });

    it(`when it is first read from the Secrets Store in ${environment}`, async () => {
      await expect(build(environment, { get: async () => STAND_IN }).services.secrets.webhook()).rejects.toThrow(/GITHUB_WEBHOOK_SECRET holds a value/);
      await expect(build(environment, { get: async () => REAL }).services.secrets.webhook()).resolves.toBe(REAL);
    });
  }

  it("names the binding and never the value", async () => {
    const error = await build("production", { get: async () => STAND_IN }).services.secrets.webhook().catch((e: Error) => e);
    expect(String(error)).not.toContain(STAND_IN);
  });

  it("leaves the test environment its own secret", async () => {
    expect(() => build("test", STAND_IN)).not.toThrow();
    await expect(build("test", { get: async () => STAND_IN }).services.secrets.webhook()).resolves.toBe(STAND_IN);
  });
});

import { describe, expect, it } from "vitest";
import { FakeMail } from "@packserver/ports/fakes";
import { FAKE_WORKERS } from "../fake-workers";
import { discoverWorkers, fakesFor, REPO_ROOT } from "../harness";
import { loadSpecs } from "../registry";
import { Aliases } from "../world/alias";
import { NotImplemented, stubModule } from "../world/errors";
import { invocationsFromLogs } from "../world/recorder";
import { createMail } from "../world/mail";
import { CATEGORY_TAGS, scenarioTestOptions } from "../vitest";
import type { Driver } from "../drivers/driver";

describe("per-area stubs", () => {
  it("throw NotImplemented naming the verb's path, at any depth", () => {
    const world = stubModule<{ personas: { youngUser(): void }; visitor(): void }>("world");
    expect(() => world.visitor()).toThrow(new NotImplemented("world.visitor"));
    expect(() => world.personas.youngUser()).toThrow(/world\.personas\.youngUser is not implemented/);
  });
});

describe("aliasing", () => {
  it("is stable within a world, repeatable for a title, different across titles, and reversible in the system's own text", () => {
    const a = new Aliases("t");
    const b = new Aliases("u");
    expect(a.alias("acme")).toBe(a.alias("acme"));
    expect(new Aliases("t").alias("acme")).toBe(a.alias("acme"));
    expect(a.alias("acme")).not.toBe(b.alias("acme"));
    expect(a.alias("acme")).toMatch(/^acme-[0-9a-f]{4}$/);
    expect(new Aliases("t", "run-1").alias("acme")).not.toBe(new Aliases("t", "run-2").alias("acme"));
    expect(a.unalias(`error: ${a.alias("acme")} not found`)).toBe("error: acme not found");
  });
});

describe("the harness composition", () => {
  it("discovers every Worker directory, web first", () => {
    const found = discoverWorkers(REPO_ROOT);
    expect(found[0]).toBe("web");
    expect(found).toHaveLength(8);
  });

  it("boots exactly the fakes the trust table binds, plus the clock", () => {
    expect(fakesFor(["web"])).toEqual(["fake-clock"]);
    expect(fakesFor(["mcp", "admin"])).toEqual(["fake-access", "fake-ai", "fake-clock", "fake-vectorize"]);
    expect(fakesFor(["validator"])).toEqual(["fake-ai", "fake-clock", "fake-sandbox-a", "fake-sandbox-b", "fake-vectorize"]);
  });

  it("has an implementation for every fake the trust table names", () => {
    expect(() => fakesFor(discoverWorkers(REPO_ROOT))).not.toThrow();
    expect(Object.keys(FAKE_WORKERS).sort()).toEqual(["fake-access", "fake-ai", "fake-clock", "fake-sandbox-a", "fake-sandbox-b", "fake-vectorize"]);
  });
});

describe("the specs", () => {
  it("reads test ids, titles and Covers from docs/testing, and ids from the register", () => {
    const specs = loadSpecs();
    expect(specs.tests.get("IT-OPS-006")).toMatchObject({ covers: ["REQ-OPS-006"], title: "Every response names the version that produced it" });
    expect(specs.tests.get("IT-OPS-001")?.runs).toMatch(/needs reset/);
    expect(specs.requirements.map((r) => r.id)).toContain("REQ-ACC-001");
  });

  it("declares every requirement id and every category as a strict tag", () => {
    const { tags, strictTags } = scenarioTestOptions();
    const names = tags.map((t) => t.name);
    expect(strictTags).toBe(true);
    expect(names).toContain("req/REQ-ACC-001");
    for (const c of CATEGORY_TAGS) expect(names).toContain(c.name);
  });
});

describe("mail", () => {
  const driver = (mail: FakeMail): Driver => ({ kind: "inprocess", fakes: { ports: { mail } } }) as unknown as Driver;

  it("reads an address's notices with their links and one-time code", async () => {
    const mail = new FakeMail();
    await mail.send({ to: "ann@example.test", subject: "Sign in", text: "Your code is 123456", html: '<a href="https://x.test/a?b=1&amp;c=2">go</a>' });
    await mail.send({ to: "bob@example.test", subject: "Other", text: "" });
    const inbox = createMail(driver(mail)).inbox({ email: "ann@example.test" });
    expect(inbox.all()).toHaveLength(1);
    expect(inbox.latest()).toMatchObject({ subject: "Sign in", code: "123456", links: ["https://x.test/a?b=1&c=2"] });
  });

  it("says so when nothing arrived", () => {
    expect(() => createMail(driver(new FakeMail())).inbox({ email: "ann@example.test" }).latest()).toThrow(/has received no mail/);
  });
});

describe("the recorder view", () => {
  it("reads a Worker's record envelopes out of its log lines and ignores everything else", () => {
    const envelope = { v: 1, invocations: [{ kind: "d1", target: "DB", op: "query", effect: "read", request: { sql: "select 1" } }] };
    const seen = invocationsFromLogs(["plain log", `[web] ${JSON.stringify(envelope)}`, '{"event":"stub.run"}', "{broken"]);
    expect(seen).toEqual([{ kind: "d1", target: "DB", op: "query", effect: "read", request: { sql: "select 1" }, result: undefined, seenBy: "worker" }]);
  });
});

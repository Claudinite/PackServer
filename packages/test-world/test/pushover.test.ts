import { describe, expect, it } from "vitest";
import { FakePushover, PUSHOVER_ARIEL_USER, PUSHOVER_MESSAGES_URL, PUSHOVER_TEST_TOKEN } from "../fakes/pushover";

const post = (fake: FakePushover, fields: Record<string, string>, url = PUSHOVER_MESSAGES_URL) =>
  fake.handler()(new Request(url, { method: "POST", body: new URLSearchParams(fields) }));

describe("the Pushover fake", () => {
  it("delivers to Ariel with the application token and refuses anyone else", async () => {
    const fake = new FakePushover();
    expect((await post(fake, { token: PUSHOVER_TEST_TOKEN, user: PUSHOVER_ARIEL_USER, title: "t", message: "m", priority: "1", url: "https://a/ops" }))?.status).toBe(200);
    expect((await post(fake, { token: PUSHOVER_TEST_TOKEN, user: "someone-else", title: "t", message: "m" }))?.status).toBe(400);
    expect((await post(fake, { token: "wrong", user: PUSHOVER_ARIEL_USER, title: "t", message: "m" }))?.status).toBe(400);
    expect(fake.delivered).toEqual([{ title: "t", message: "m", priority: 1, url: "https://a/ops" }]);
    expect(fake.refused.map((r) => r.reason)).toEqual(["user", "application token"]);
  });
  it("can be taken down and reset, and claims no other URL", async () => {
    const fake = new FakePushover();
    fake.outage();
    expect((await post(fake, { token: PUSHOVER_TEST_TOKEN, user: PUSHOVER_ARIEL_USER }))?.status).toBe(500);
    fake.reset();
    expect((await post(fake, { token: PUSHOVER_TEST_TOKEN, user: PUSHOVER_ARIEL_USER }))?.status).toBe(200);
    expect(await post(fake, {}, "https://example.com/x")).toBeUndefined();
  });
});

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { GITHUB_CLIENT } from "../src/pages/github/client";

/** Runs the page script against a stand-in document and submits one registration form. */
async function submit(checked: string[]) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const sent: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const value = (v: string) => ({ value: v });
  const attrs: Record<string, string> = { "data-scope": "acme", "data-pack": "gcp" };
  const form = {
    classList: { contains: (c: string) => c === "reg" },
    getAttribute: (n: string) => attrs[n] ?? null,
    elements: { repository: value("acme/packs"), repository_id: value("1"), repository_owner_id: value("2"), workflow: value(".github/workflows/p.yml"), path: value("p"), environment: value(""), refs: value("") },
    querySelectorAll: () => ["push", "release", "workflow_dispatch"].map((v) => ({ value: v, checked: checked.includes(v) })),
  };
  const PS = {
    declined: () => false,
    api: async (method: string, url: string, body: Record<string, unknown>) => { sent.push({ method, url, body }); return {}; },
    sensitive: async (ask: { run(assertion: string): Promise<unknown> }) => ({ result: await ask.run("a") }),
  };
  runInNewContext(GITHUB_CLIENT, {
    window: { PS },
    document: { getElementById: () => ({ textContent: "" }), addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f; } },
    location: { reload: () => undefined },
    encodeURIComponent,
    Promise,
  });
  listeners.submit!({ target: form, preventDefault: () => undefined });
  await new Promise((r) => setTimeout(r, 0));
  return sent;
}

describe("GitHub page script", () => {
  it("sends the events that are checked, and an empty list when none is, so the route can refuse it", async () => {
    expect((await submit(["push"]))[0]!.body.events).toEqual(["push"]);
    const none = await submit([]);
    expect(none).toHaveLength(1);
    expect(none[0]!.body.events).toEqual([]);
  });
});

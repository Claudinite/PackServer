import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestHarness } from "wrangler";
import { FakeWorkerClient } from "../fakes/compose";

const dropped = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code }) });

/** A harness whose Worker fails the first requests with the given errors, then answers. */
function client(failures: unknown[]) {
  const fetch = vi.fn(async () => {
    const failure = failures.shift();
    if (failure) throw failure;
    return Response.json({ result: 7 });
  });
  const server = { getWorker: () => ({ fetch }) } as unknown as TestHarness;
  return { fetch, worker: new FakeWorkerClient(server, "fake-clock") };
}

describe("FakeWorkerClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("repeats a repeatable op once when a pooled socket was already closed, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = FakeWorkerClient.droppedConnectionRetries;
    const { fetch, worker } = client([dropped("UND_ERR_SOCKET")]);
    expect(await worker.call("reset")).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(FakeWorkerClient.droppedConnectionRetries).toBe(before + 1);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toMatch(/connection dropped.*\n.*stayed up/);
  });

  it("repeats at most once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch, worker } = client([dropped("ECONNRESET"), dropped("ECONNRESET")]);
    await expect(worker.call("now")).rejects.toThrow("fetch failed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never repeats an op that changes state each time it is seen", async () => {
    const { fetch, worker } = client([dropped("UND_ERR_SOCKET")]);
    await expect(worker.call("advance", { by: "1h" })).rejects.toThrow("fetch failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not hide other failures", async () => {
    const { fetch, worker } = client([new TypeError("fetch failed")]);
    await expect(worker.call("reset")).rejects.toThrow("fetch failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

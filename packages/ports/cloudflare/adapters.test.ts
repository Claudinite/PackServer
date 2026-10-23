import { describe, expect, it, vi } from "vitest";
import { PortError } from "../src/ports";
import { missingBindings, expectedBindings } from "../src/trust-table";
import {
  d1Port, durableObjectsPort, isServiceBinding, kvPort, queuePort, r2Port, r2ReadPort, rateLimitPort, readSecret,
  turnstilePort, unwiredPort, versionInfo, workflowPort,
} from "./index";

describe("D1", () => {
  const statement = (rows: unknown[]) => ({ bind: vi.fn(() => ({ all: async () => ({ results: rows, meta: { changes: 2, last_row_id: 7 } }) })) });
  it("binds parameters and shapes the result", async () => {
    const prepared = statement([{ a: 1 }]);
    const db = { prepare: vi.fn(() => prepared) } as unknown as D1Database;
    expect(await d1Port(db).query("SELECT ?", [5])).toEqual({ rows: [{ a: 1 }], meta: { changes: 2, last_row_id: 7 } });
    expect(prepared.bind).toHaveBeenCalledWith(5);
  });

  it("runs a batch through the binding's batch", async () => {
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => "stmt") })),
      batch: vi.fn(async () => [{ results: [], meta: { changes: 1, last_row_id: null } }]),
    } as unknown as D1Database;
    expect(await d1Port(db).batch([{ sql: "INSERT" }])).toEqual([{ rows: [], meta: { changes: 1, last_row_id: null } }]);
  });
});

describe("R2", () => {
  const bucket = (pages: Array<{ keys: string[]; cursor?: string }>) => {
    let i = 0;
    return {
      get: vi.fn(async (k: string) => (k === "hit" ? { arrayBuffer: async () => new Uint8Array([1, 2]).buffer } : null)),
      head: vi.fn(async (k: string) => (k === "hit" ? { size: 2 } : null)),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => {
        const page = pages[i++]!;
        return { objects: page.keys.map((key) => ({ key })), truncated: page.cursor !== undefined, cursor: page.cursor };
      }),
    } as unknown as R2Bucket;
  };

  it("reads bytes, sizes and every page of a listing", async () => {
    const port = r2ReadPort(bucket([{ keys: ["a"], cursor: "c1" }, { keys: ["b"] }]));
    expect(await port.get("hit")).toEqual(new Uint8Array([1, 2]));
    expect(await port.get("miss")).toBeNull();
    expect(await port.head("hit")).toEqual({ size: 2 });
    expect(await port.list("")).toEqual(["a", "b"]);
  });

  it("gives a read port no write method and a full port both", async () => {
    const b = bucket([]);
    expect(Object.keys(r2ReadPort(b)).sort()).toEqual(["get", "head", "list"]);
    await r2Port(b).put("k", new Uint8Array([1]), { content_type: "text/plain" });
    expect((b.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toEqual({ httpMetadata: { contentType: "text/plain" } });
    await r2Port(b).delete("k");
    expect(b.delete).toHaveBeenCalledWith("k");
  });
});

describe("KV", () => {
  it("refuses an expiry KV would reject, and passes a valid one", async () => {
    const put = vi.fn();
    const port = kvPort({ put } as unknown as KVNamespace);
    await expect(port.put("k", "v", { ttl_seconds: 59 })).rejects.toThrow(PortError);
    await port.put("k", "v", { ttl_seconds: 60 });
    await port.put("k", "v");
    expect(put.mock.calls).toEqual([["k", "v", { expirationTtl: 60 }], ["k", "v", undefined]]);
  });

  it("lists every page", async () => {
    const list = vi.fn().mockResolvedValueOnce({ keys: [{ name: "a" }], list_complete: false, cursor: "c" }).mockResolvedValueOnce({ keys: [{ name: "b" }], list_complete: true });
    expect(await kvPort({ list } as unknown as KVNamespace).list("p")).toEqual(["a", "b"]);
  });
});

describe("queues, workflows, rate limits, stats", () => {
  it("wraps batch messages as bodies", async () => {
    const sendBatch = vi.fn();
    await queuePort({ sendBatch } as never).sendBatch([{ a: 1 }]);
    expect(sendBatch).toHaveBeenCalledWith([{ body: { a: 1 } }]);
  });

  it("creates and reads a workflow instance", async () => {
    const create = vi.fn(async () => ({ id: "i1" }));
    const get = vi.fn(async () => ({ status: async () => ({ status: "running" }) }));
    const port = workflowPort({ create, get } as never);
    expect(await port.create({ id: "i1", params: { a: 1 } })).toEqual({ id: "i1" });
    expect(create).toHaveBeenCalledWith({ id: "i1", params: { a: 1 } });
    expect(await port.status("i1")).toEqual({ status: "running" });
  });

  it("limits through the binding", async () => {
    expect(await rateLimitPort({ limit: async () => ({ success: false }) } as never).limit({ key: "k" })).toEqual({ success: false });
  });
});

describe("Durable Objects", () => {
  it("calls the named method on the object of that name", async () => {
    const ping = vi.fn(async () => ({ schema_version: 1, ok: true }));
    const getByName = vi.fn(() => ({ ping }));
    const port = durableObjectsPort({ Quota: { getByName } as never });
    expect(await port.call("Quota", "q1", "ping", [])).toEqual({ schema_version: 1, ok: true });
    expect(getByName).toHaveBeenCalledWith("q1");
  });

  it("refuses a namespace the Worker does not hold", async () => {
    await expect(durableObjectsPort({}).call("Quota", "q1", "ping", [])).rejects.toThrow("no Quota binding");
  });
});

describe("secrets, turnstile, service bindings", () => {
  it("reads a Secrets Store binding or a plain test value, and names a missing one", async () => {
    expect(await readSecret("plain")).toBe("plain");
    expect(await readSecret({ get: async () => "stored" } as never)).toBe("stored");
    await expect(readSecret(undefined)).rejects.toThrow("not bound");
  });

  it("verifies with the secret and the caller's address, and fails closed when the service is down", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ success: true, "error-codes": [], echo: String(init?.body) }));
    const port = turnstilePort(async () => "s3cret", fetcher as never);
    expect(await port.verify("tok", "203.0.113.5")).toEqual({ success: true, codes: [] });
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toBe("secret=s3cret&response=tok&remoteip=203.0.113.5");
    const down = turnstilePort(async () => "s", (async () => new Response("", { status: 503 })) as never);
    expect(await down.verify("tok")).toEqual({ success: false, codes: ["siteverify-unavailable"] });
  });

  it("tells a service binding from a product binding", () => {
    expect(isServiceBinding({ fetch: () => {} })).toBe(true);
    expect(isServiceBinding({ getByName: () => {} })).toBe(false);
    expect(isServiceBinding(undefined)).toBe(false);
  });

  it("reports a call on an unwired port instead of doing nothing", () => {
    const port = unwiredPort<{ verify(): void }>("access");
    expect(() => port.verify()).toThrow("access.verify has no production adapter yet");
  });
});

describe("version and bindings", () => {
  it("reads the release from the version tag", () => {
    expect(versionInfo({ id: "v", tag: "1.2.3+abc1234" })).toEqual({ versionId: "v", releaseId: "1.2.3+abc1234" });
    expect(versionInfo({ id: "v", tag: "" })).toEqual({ versionId: "v", releaseId: "unreleased" });
    expect(versionInfo(undefined)).toEqual({ versionId: "unknown", releaseId: "unreleased" });
  });

  it("names the bindings an env lacks", () => {
    const env = Object.fromEntries(expectedBindings("judge").map((n) => [n, {}]));
    expect(missingBindings("judge", env)).toEqual([]);
    delete env.ADMIN;
    expect(missingBindings("judge", env)).toEqual(["ADMIN"]);
  });
});

import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cnFromTarball, installCn } from "../src/cn.ts";
import { enc, sha256, tgzOf } from "./helpers.ts";

const binary = enc("#!/bin/sh\necho cn\n");
const tgz = tgzOf("package/bin/cn", binary);

describe("cn install", () => {
  it("extracts package/bin/cn from a tarball whose hash is the pin", () => {
    expect(Buffer.from(cnFromTarball(tgz, sha256(tgz))).toString()).toBe(Buffer.from(binary).toString());
  });

  it("refuses a hash mismatch before extracting anything", () => {
    expect(() => cnFromTarball(tgz, "0".repeat(64))).toThrow(/pinned SHA-256/);
    expect(() => cnFromTarball(tgzOf("package/bin/cn", enc("evil")), sha256(tgz))).toThrow(/pinned SHA-256/);
  });

  it("refuses a package without the binary", () => {
    const other = tgzOf("package/README.md", enc("x"));
    expect(() => cnFromTarball(other, sha256(other))).toThrow(/package\/bin\/cn/);
  });

  it("writes an executable only after the download is verified", async () => {
    const ok = async () => new Response(tgz, { status: 200, headers: { "content-length": String(tgz.length) } });
    const file = await installCn({ version: "1.0.0", sha256: sha256(tgz), url: "https://npm.test/cn.tgz" }, ok as typeof fetch);
    expect(await readFile(file, "utf8")).toBe(Buffer.from(binary).toString());
    expect((await stat(file)).mode & 0o111).not.toBe(0);
    await expect(installCn({ version: "1.0.0", sha256: "f".repeat(64), url: "https://npm.test/cn.tgz" }, ok as typeof fetch)).rejects.toThrow(/pinned/);
    const missing = async () => new Response("no", { status: 404 });
    await expect(installCn({ version: "9.9.9", sha256: sha256(tgz), url: "u" }, missing as typeof fetch)).rejects.toThrow(/HTTP 404/);
  });
});

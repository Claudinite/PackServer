import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const BINARY_PATH = "package/bin/cn";

export const defaultCnUrl = (version: string) => `https://registry.npmjs.org/@claudinite/cli-linux-x64/-/cli-linux-x64-${version}.tgz`;

/** Reads the body up to the size cap, so an endless answer cannot fill the runner. */
async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES || !response.body) throw new Error("the cn download is over the size limit or empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error("the cn download is over the size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The bytes of one regular file in a ustar archive, or null. */
export function fileFromTar(tar: Uint8Array, wanted: string): Uint8Array | null {
  const text = new TextDecoder();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) return null;
    const field = (from: number, length: number) => text.decode(header.subarray(from, from + length)).replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const start = at + 512;
    if (name === wanted && (type === "0" || type === "")) return tar.subarray(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * The npm tarball is hashed against the pin before any byte of it is unpacked or written. This is
 * the pin-then-extract order of the Engine's setup-cn.sh, which cannot be reused here: it reads a
 * member's settings.yaml and a manifest pin, and a publisher's repository has neither.
 */
export function cnFromTarball(tgz: Uint8Array, expectedSha256: string): Uint8Array {
  const actual = createHash("sha256").update(tgz).digest("hex");
  if (actual !== expectedSha256.toLowerCase()) throw new Error("the cn download does not match the pinned SHA-256");
  const binary = fileFromTar(gunzipSync(tgz, { maxOutputLength: 4 * MAX_DOWNLOAD_BYTES }), BINARY_PATH);
  if (!binary) throw new Error(`the cn package holds no ${BINARY_PATH}`);
  return binary;
}

export async function installCn(input: { version: string; sha256: string; url: string }, fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn(input.url);
  if (!response.ok) throw new Error(`cn ${input.version} could not be downloaded (HTTP ${response.status})`);
  const binary = cnFromTarball(await boundedBody(response), input.sha256);
  const file = join(await mkdtemp(join(tmpdir(), "cn-")), "cn");
  await writeFile(file, binary);
  await chmod(file, 0o755);
  return file;
}

export function runVendor(cn: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cn, ["vendor"], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cn vendor exited with ${code}`))));
  });
}

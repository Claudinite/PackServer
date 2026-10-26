import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const defaultCnUrl = (version: string) => `https://github.com/Claudinite/Engine/releases/download/v${version}/cn-linux-x64`;

/** Downloads cn and refuses it unless its SHA-256 is the pinned one. */
export async function installCn(input: { version: string; sha256: string; url: string }, fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn(input.url);
  if (!response.ok) throw new Error(`cn ${input.version} could not be downloaded (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== input.sha256.toLowerCase()) throw new Error(`cn ${input.version} does not match the pinned SHA-256`);
  const file = join(await mkdtemp(join(tmpdir(), "cn-")), "cn");
  await writeFile(file, bytes);
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

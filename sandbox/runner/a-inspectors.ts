import type { Tree } from "@packserver/core/canonical";
import type { Finding } from "@packserver/schema";

export interface InspectorInput {
  tree: Tree;
  pack: string;
  previousCapabilities: unknown;
}

export interface Inspector {
  name: string;
  inspect(input: InspectorInput): Promise<{ findings: Finding[]; capabilities?: unknown }>;
}

/** Specifier of the capability inspector (T-042); absent until that task merges. */
const CAPABILITY_MODULE = "@packserver/core/capabilities";

const ABSENT_CODES = new Set(["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);
// Test loaders (vite) report the same condition without Node's codes.
const ABSENT_MESSAGE = /is not exported under|Cannot find (module|package)|Failed to (load|resolve) (url|import)/;

/** Absent means the module itself is missing; a module that exists but cannot load one of its own imports is broken. */
function isAbsent(e: unknown, specifier: string): boolean {
  const message = String((e as Error)?.message);
  const code = (e as { code?: string }).code ?? "";
  if (!ABSENT_CODES.has(code) && !ABSENT_MESSAGE.test(message)) return false;
  const pkg = /^(@[^/]+\/[^/]+|[^/]+)/.exec(specifier)?.[0] ?? specifier;
  const subpath = specifier.replace(pkg, ".");
  const named = (n: string) => message.includes(`'${n}'`) || message.includes(`"${n}"`);
  return named(specifier) || named(subpath) || named(pkg);
}

/**
 * The optional inspectors, each with a note saying why it did not load. A module that exists but
 * fails to load is a defect and propagates, so a broken inspector never reads as an absent one.
 */
export async function loadOptionalInspectors(
  specifiers: readonly string[] = [CAPABILITY_MODULE],
): Promise<{ inspectors: Inspector[]; skipped: { name: string; note: string }[] }> {
  const inspectors: Inspector[] = [];
  const skipped: { name: string; note: string }[] = [];
  for (const specifier of specifiers) {
    try {
      // A variable specifier keeps the bundler from requiring a module that may not exist yet.
      const mod = (await import(specifier)) as { inspector?: Inspector };
      if (!mod.inspector) throw new Error(`${specifier} exports no inspector`);
      inspectors.push(mod.inspector);
    } catch (e) {
      if (isAbsent(e, specifier)) skipped.push({ name: specifier, note: "module not present in this image" });
      else throw e;
    }
  }
  return { inspectors, skipped };
}

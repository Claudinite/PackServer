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

const isAbsent = (e: unknown) => ABSENT_CODES.has((e as { code?: string }).code ?? "") || ABSENT_MESSAGE.test(String((e as Error)?.message));

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
      if (isAbsent(e)) skipped.push({ name: specifier, note: "module not present in this image" });
      else throw e;
    }
  }
  return { inspectors, skipped };
}

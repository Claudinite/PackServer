import { expectedVerdict, fixtureArchive, FIXTURE_NAMES, type FixtureName } from "../../../packages/core/canonical/fixtures.ts";
import type { ArchiveReason } from "../../../packages/core/canonical/index.ts";

export interface CorpusCase {
  name: FixtureName;
  expect: "ok" | ArchiveReason;
  build: () => Uint8Array;
}

const HOSTILE_UPLOADS: readonly FixtureName[] = ["with-symlink", "with-hardlink", "case-collision", "nested-archive"];

const caseOf = (name: FixtureName): CorpusCase => ({ name, expect: expectedVerdict(name), build: () => fixtureArchive(name) });

/** Every fixture the bounded decoder refuses: the `bomb-*` shapes and the unsafe-entry uploads. */
export const refusedCorpus = (): CorpusCase[] => FIXTURE_NAMES.filter((n) => n.startsWith("bomb-") || HOSTILE_UPLOADS.includes(n)).map(caseOf);

/** Uploads that are accepted and must come out as a canonical archive. */
export const acceptedCorpus = (): CorpusCase[] => FIXTURE_NAMES.filter((n) => expectedVerdict(n) === "ok").map(caseOf);

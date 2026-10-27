import { advisoriesFor } from "@packserver/core/reports";
import { newFindings, reasonOf, rescore, rulesOrNull, screenChanged, screenRescan, staticRescan } from "@packserver/core/validation";
import type { RulesVersion } from "@packserver/rules";
import type { ValidatorRuntime } from "../bindings";
import { materialOf, originalFindings } from "./material";
import { quarantine } from "./quarantine";
import type { Candidate } from "./store";

export interface Visited {
  /** Whether the version was judged; a version already scored under these rules, or one whose objects are unreadable, is not. */
  judged: boolean;
  /** How many findings the rescan reached that the version was not already judged on. */
  found: number;
  quarantined: boolean;
}

/**
 * REQ-VAL-018 and REQ-SCORE-003 for one version under a newer rules version: the static rules, the
 * prose screen when its questions or implementation changed, and the score. A version validated under
 * these very rules has nothing new to learn and is left alone.
 */
export async function rescanRules(rt: ValidatorRuntime, candidate: Candidate, latest: RulesVersion): Promise<Visited> {
  if (candidate.score_rules_version === latest.version) return { judged: false, found: 0, quarantined: false };
  const material = await materialOf(rt, candidate);
  if (!material) {
    console.log(JSON.stringify({ event: "validator.rescan_unreadable", pack: candidate.pack, version: candidate.version }));
    return { judged: false, found: 0, quarantined: false };
  }
  const from = rulesOrNull(candidate.score_rules_version);
  const found = staticRescan(material.tree, latest);
  if (from === null || screenChanged(from, latest)) found.push(...(await screenRescan(material.tree, latest)));
  const fresh = newFindings(found, await originalFindings(rt, candidate));

  // The status first: a retry after a crash finds the version already moved and still records the score.
  const reason = reasonOf(fresh);
  const quarantined = reason === null ? false : await quarantine(rt, candidate, reason);

  const advisory = (await advisoriesFor(rt.ports.d1, candidate.pack_id, candidate.version)).length > 0;
  const scored = rescore({ tree: material.tree, meta: material.meta, publishedAdvisory: advisory, rulesVersion: latest.version });
  await rt.ports.d1.query(`update pack_versions set score = ?, score_rules_version = ?, score_breakdown = ? where id = ?`, [
    scored.total,
    latest.version,
    JSON.stringify({ parts: scored.parts, cap: scored.cap }),
    candidate.id,
  ]);
  return { judged: true, found: fresh.length, quarantined };
}

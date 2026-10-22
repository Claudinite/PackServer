import type { Notice } from "../notice";

/** REQ-MOD-014: an upheld appeal restores the pack; a denied one is final. */
export interface AppealDecided {
  pack: string;
  outcome: "upheld" | "denied";
  packUrl: string;
}

export const appealDecided = (d: AppealDecided): Notice => ({
  subject: `Your appeal for ${d.pack} was ${d.outcome}`,
  paragraphs:
    d.outcome === "upheld"
      ? [`Your appeal was upheld and ${d.pack} was restored.`]
      : [`Your appeal was denied. This decision is final.`],
  action: { label: "Open the pack", url: d.packUrl },
});

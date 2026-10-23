/** Optimal string alignment distance: insert, delete, substitute, and swap of neighbours. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

// Cyrillic, Greek and Cherokee letters, fullwidth forms and digits that read as a Latin letter.
const LOOKALIKE: Record<string, string> = {
  \u0430: "a", \u0432: "b", \u0441: "c", \u0501: "d", \u0435: "e", \u04bb: "h", \u0456: "i", \u0458: "j", \u043a: "k", \u04cf: "l", \u043c: "m", \u043d: "h", \u043e: "o", \u0440: "p", \u051b: "q", \u0433: "r", \u0455: "s", \u0442: "t", \u057d: "u", \u0475: "v", \u051d: "w", \u0445: "x", \u0443: "y", \u1d22: "z",
  \u03b1: "a", \u03b2: "b", \u03b5: "e", \u03b7: "n", \u03b9: "i", \u03ba: "k", \u03bd: "v", \u03bf: "o", \u03c1: "p", \u03c4: "t", \u03c5: "u", \u03c7: "x", \u03b3: "y", \u03c9: "w",
  \u0131: "i", \u0261: "g", \u01c0: "l", "0": "o", "1": "l",
};

/** Folds a name to the letters a reader would see, so lookalikes compare equal. */
export function skeleton(name: string): string {
  const lowered = name.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of lowered) out += LOOKALIKE[ch] ?? ch;
  return out.replace(/[._-]/g, "").replace(/rn/g, "m").replace(/vv/g, "w").replace(/[li]/g, "l");
}

/** The distance within which two names of these lengths count as near; short names must match more closely. */
export function nearThreshold(a: string, b: string): number {
  const shortest = Math.min(a.length, b.length);
  return shortest >= 5 ? 2 : shortest >= 3 ? 1 : 0;
}

/** True when `candidate` is a near miss of `target` without being it. */
export function isNearMiss(candidate: string, target: string): boolean {
  if (candidate === target) return false;
  const distance = editDistance(candidate, target);
  if (distance > 0 && distance <= nearThreshold(candidate, target)) return true;
  return skeleton(candidate) === skeleton(target);
}

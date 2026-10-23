const FORCED_KEYS = new Set(["forced", "force", "forceon", "forcedon", "forcebefore", "forcedbefore"]);
const FALSY = new Set(["false", "no", "off", "0", "null", "~", "none"]);

export const isFalsyScalar = (v: string): boolean => FALSY.has(v.trim().replace(/^["']|["']$/g, "").toLowerCase());

/** The leading `---` block of a skill, read for the keys that force it to load. */
export function parseFrontmatter(text: string): { forced: boolean } {
  const body = text.replace(/^\ufeff/, "");
  if (!/^---[ \t]*\r?\n/.test(body)) return { forced: false };
  const end = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(body.slice(3));
  const block = body.slice(3, end ? 3 + end.index : Math.min(body.length, 20000));
  for (const raw of block.split(/\r?\n/)) {
    const m = /^["']?([A-Za-z_-]{1,40})["']?[ \t]*:(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1]!.replace(/[_-]/g, "").toLowerCase();
    if (!FORCED_KEYS.has(key)) continue;
    const value = m[2]!.replace(/\s+#.*$/, "").trim();
    if (!isFalsyScalar(value)) return { forced: true };
  }
  return { forced: false };
}

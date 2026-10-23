const FALSY = new Set(["false", "no", "off", "0", "null", "~", "none"]);

export const isFalsyScalar = (v: string): boolean => FALSY.has(v.trim().replace(/^["']|["']$/g, "").toLowerCase());

const isForcing = (key: string): boolean => {
  const k = key.replace(/[_-]/g, "").toLowerCase();
  return k.startsWith("forceload") || k === "forced" || k === "force" || k === "forcebefore" || k === "forcedbefore" || k === "forceon" || k === "forcedon";
};

/**
 * The leading `---` block of a skill, read for keys that force it to load, at any indentation:
 * `force-load-on-*` sits under `metadata:` in the canon packs.
 */
export function parseFrontmatter(text: string): { forced: boolean } {
  const body = text.replace(/^\ufeff/, "");
  if (!/^---[ \t]*\r?\n/.test(body)) return { forced: false };
  const end = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(body.slice(3));
  const block = body.slice(3, end ? 3 + end.index : Math.min(body.length, 20000));
  for (const raw of block.split(/\r?\n/)) {
    const m = /^[ \t]*["']?([A-Za-z_-]{1,60})["']?[ \t]*:(.*)$/.exec(raw);
    if (!m || !isForcing(m[1]!)) continue;
    const value = m[2]!.replace(/\s+#.*$/, "").trim();
    if (!isFalsyScalar(value)) return { forced: true };
  }
  return { forced: false };
}

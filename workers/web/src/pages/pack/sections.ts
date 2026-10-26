export interface Section {
  /** Stable within the file: comments attach to it by this id. */
  id: string;
  text: string;
}

/** Percent-encodes anything an HTML id or URL fragment would mishandle, so two paths never share an anchor. */
export function fileAnchor(path: string): string {
  return `f:${path.replace(/[^A-Za-z0-9._/-]/g, (ch) => [...new TextEncoder().encode(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""))}`;
}

const slug = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";

/**
 * Markdown files split before each heading (a `#` inside a fenced block is not one); anything else is one section.
 * The sections joined are the file, byte for byte.
 */
export function sectionsOf(path: string, text: string): Section[] {
  const anchor = fileAnchor(path);
  if (!path.endsWith(".md")) return [{ id: `${anchor}~top`, text }];
  const lines = text.split("\n");
  const pieces: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  let fence: string | null = null;
  for (const line of lines) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark !== undefined) {
      if (fence === null) fence = mark;
      else if (mark.startsWith(fence[0] ?? "") && mark.length >= fence.length) fence = null;
    }
    const heading = fence === null && mark === undefined ? /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1] : undefined;
    if (heading !== undefined) pieces.push({ heading, lines: [line] });
    else pieces[pieces.length - 1]?.lines.push(line);
  }
  const seen = new Map<string, number>();
  const sections: Section[] = [];
  for (const [i, piece] of pieces.entries()) {
    const body = piece.lines.join("\n") + (i < pieces.length - 1 ? "\n" : "");
    if (piece.heading === null) {
      if (piece.lines.length > 0) sections.push({ id: `${anchor}~top`, text: body });
      continue;
    }
    const base = slug(piece.heading);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    sections.push({ id: `${anchor}~${n === 1 ? base : `${base}-${n}`}`, text: body });
  }
  return sections.length === 0 ? [{ id: `${anchor}~top`, text }] : sections;
}

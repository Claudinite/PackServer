import type { Tree, TreeFile } from "../../canonical/index.ts";

export interface TextFile {
  path: string;
  text: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A file is text when it is valid UTF-8 with no NUL. */
export function decodeText(file: TreeFile): string | null {
  if (file.content.includes(0)) return null;
  try {
    return decoder.decode(file.content);
  } catch {
    return null;
  }
}

export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function textFiles(tree: Tree): TextFile[] {
  const out: TextFile[] = [];
  for (const f of tree.files) {
    const text = decodeText(f);
    if (text !== null) out.push({ path: f.path, text });
  }
  return out;
}

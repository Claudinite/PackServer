import type { TreeFile } from "../../canonical/index.ts";
import { decodeText } from "../engine/files.ts";
import { lexGo, type GoLex } from "./golex.ts";
import { lexJs, type JsLex } from "./js.ts";

const go = new WeakMap<TreeFile, GoLex | null>();
const js = new WeakMap<TreeFile, JsLex | null>();

/** Capability extraction and the code rules read the same files; each is lexed once. */
export function goLexOf(file: TreeFile): GoLex | null {
  if (!go.has(file)) {
    const d = decodeText(file);
    go.set(file, d ? lexGo(d.text) : null);
  }
  return go.get(file) ?? null;
}

export function jsLexOf(file: TreeFile): JsLex | null {
  if (!js.has(file)) {
    const d = decodeText(file);
    js.set(file, d ? lexJs(d.text) : null);
  }
  return js.get(file) ?? null;
}

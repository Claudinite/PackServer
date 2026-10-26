import { buildTree, canonicalise } from "@packserver/core/canonical";

export const enc = (text: string) => new TextEncoder().encode(text);

export const samplePack = () =>
  canonicalise(buildTree([{ path: "RULES.md", executable: false, content: enc("# rules\n") }]));

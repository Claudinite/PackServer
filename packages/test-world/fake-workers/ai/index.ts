import { WorkerEntrypoint } from "cloudflare:workers";
import { EMBEDDING_DIMENSIONS } from "@packserver/ports/cloudflare";
import { sha256Hex } from "@packserver/ports";
import { handleControl } from "../control";

const COST_PER_TEXT = 0.0001;
const table = new Map<string, number[]>();

/** bge-m3 is 1024 wide; a hash chain stretches one digest to that width, then it is made a unit vector. */
async function vectorOf(text: string): Promise<number[]> {
  const raw: number[] = [];
  for (let block = 0; raw.length < EMBEDDING_DIMENSIONS; block++) {
    const hex = await sha256Hex(`${block}:${text}`);
    for (let i = 0; i < 32 && raw.length < EMBEDDING_DIMENSIONS; i++) raw.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16) - 127.5);
  }
  const norm = Math.sqrt(raw.reduce((n, x) => n + x * x, 0));
  return raw.map((x) => x / norm);
}
const state = { calls: [] as number[], cost: 0 };

/** Stands in for Workers AI `bge-m3`: a hash becomes a unit vector, a recorded table overrides it. */
export default class FakeAi extends WorkerEntrypoint {
  async embed(texts: string[]): Promise<number[][]> {
    state.calls.push(texts.length);
    state.cost += texts.length * COST_PER_TEXT;
    return Promise.all(texts.map(async (t) => table.get(t) ?? (await vectorOf(t))));
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      reset: () => {
        state.calls = [];
        state.cost = 0;
        table.clear();
      },
      remember: ({ text, vector }: { text: string; vector: number[] }) => void table.set(text, vector),
      calls: () => state.calls,
      cost: () => state.cost,
    });
  }
}

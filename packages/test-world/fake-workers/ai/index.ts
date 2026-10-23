import { WorkerEntrypoint } from "cloudflare:workers";
import { FakeEmbedder } from "@packserver/ports/fakes";
import { handleControl } from "../control";

const COST_PER_TEXT = 0.0001;
const embedder = new FakeEmbedder();
const state = { calls: [] as number[], cost: 0 };

/** Stands in for Workers AI `bge-m3`: a hash becomes a unit vector, a recorded table overrides it. */
export default class FakeAi extends WorkerEntrypoint {
  async embed(texts: string[]): Promise<number[][]> {
    state.calls.push(texts.length);
    state.cost += texts.length * COST_PER_TEXT;
    return embedder.embed(texts);
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      reset: () => {
        state.calls = [];
        state.cost = 0;
        embedder.table.clear();
      },
      remember: ({ text, vector }: { text: string; vector: number[] }) => void embedder.table.set(text, vector),
      calls: () => state.calls,
      cost: () => state.cost,
    });
  }
}

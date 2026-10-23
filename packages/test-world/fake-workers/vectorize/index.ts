import { WorkerEntrypoint } from "cloudflare:workers";
import type { VectorMatch } from "@packserver/ports";
import { FakeVectorIndex } from "@packserver/ports/fakes";
import { handleControl } from "../control";

const index = new FakeVectorIndex();

/** Stands in for the Vectorize index `packs`: brute-force cosine over a map. */
export default class FakeVectorize extends WorkerEntrypoint {
  upsert(items: Array<{ id: string; vector: number[]; metadata?: VectorMatch["metadata"] }>) {
    return index.upsert(items);
  }
  query(vector: number[], options: { topK: number }) {
    return index.query(vector, options);
  }
  deleteByIds(ids: string[]) {
    return index.deleteByIds(ids);
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      reset: () => index.items.clear(),
      ids: () => [...index.items.keys()].sort(),
    });
  }
}

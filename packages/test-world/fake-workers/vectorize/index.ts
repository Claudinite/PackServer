import { WorkerEntrypoint } from "cloudflare:workers";
import type { VectorMatch } from "@packserver/ports";
import { EMBEDDING_DIMENSIONS } from "@packserver/ports/cloudflare";
import { FakeVectorIndex } from "@packserver/ports/fakes";
import { handleControl } from "../control";

const index = new FakeVectorIndex();

/** The index is created with the model's width and Vectorize refuses any other. */
function widthOk(vector: number[]): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error(`vector has ${vector.length} dimensions, the index has ${EMBEDDING_DIMENSIONS}`);
}

/** Stands in for the Vectorize index `packs`: brute-force cosine over a map. */
export default class FakeVectorize extends WorkerEntrypoint {
  upsert(items: Array<{ id: string; vector: number[]; metadata?: VectorMatch["metadata"] }>) {
    for (const item of items) widthOk(item.vector);
    return index.upsert(items);
  }
  query(vector: number[], options: { topK: number }) {
    widthOk(vector);
    return index.query(vector, options);
  }
  deleteByIds(ids: string[]) {
    return index.deleteByIds(ids);
  }

  async fetch(request: Request): Promise<Response> {
    return handleControl(request, {
      reset: () => index.items.clear(),
      upsert: ({ items }: { items: Parameters<FakeVectorize["upsert"]>[0] }) => this.upsert(items),
      remove: ({ ids }: { ids: string[] }) => this.deleteByIds(ids),
      ids: () => [...index.items.keys()].sort(),
    });
  }
}

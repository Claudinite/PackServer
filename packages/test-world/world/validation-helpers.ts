import type { World } from "./world";
import type { Run } from "./publishing";

export type Publisher = Awaited<ReturnType<World["publishers"]["create"]>>;

/** Publishes `archive` as the next version of `@<handle>/tool` and waits for its verdict. */
export async function validate(world: World, publisher: Publisher, handle: string, archive: ReturnType<World["archive"]>, version: string): Promise<Run> {
  return world.validation.completes(await publisher.publish(archive).as(`@${handle}/tool@${version}`));
}

export const rulesOf = async (run: Run) => (await run.findings()).map((f) => f.rule);

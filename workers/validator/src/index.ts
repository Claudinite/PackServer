import { WorkerEntrypoint } from "cloudflare:workers";
import { logStubRun } from "@packserver/http";
import { createApp } from "./app";
import { createRuntime, type Env } from "./bindings";
import { signEntrypoints } from "./entrypoints/sign";
import { consumeNotify } from "./notify/consume";
import { consumeReindex, refreshAllScopes } from "./reindex/consume";
import { tick } from "./rescan/tick";
import { resume } from "./resumer";

export { SandboxA, SandboxB, ValidatePackWorkflow } from "./objects";

const DAILY_CRON = "0 4 * * *";
/** Applies the decisions that found no instance waiting. */
const RESUME_CRON = "*/5 * * * *";
/** Each fire advances the open rescan passes by a batch; the weekly fire is one more, so a week's passes begin on schedule even if the others were missed. */
const RESCAN_CRONS: readonly string[] = ["*/15 * * * *", "0 5 * * 1"];

/**
 * The Worker's one entrypoint: the (internal) HTTP surface, the cron, the two queue consumers and,
 * over the service binding, the signing methods only the coordinators in `publish` may call.
 */
export default class Validator extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return Promise.resolve(createApp(createRuntime(this.env)).fetch(request, undefined, this.ctx));
  }

  async scheduled(controller: ScheduledController): Promise<void> {
    if (controller.cron === RESUME_CRON) {
      await resume(createRuntime(this.env));
      return;
    }
    if (RESCAN_CRONS.includes(controller.cron)) {
      await tick(createRuntime(this.env));
      return;
    }
    if (controller.cron !== DAILY_CRON) return logStubRun("validator", controller.cron);
    await refreshAllScopes(createRuntime(this.env));
  }

  async queue(batch: MessageBatch): Promise<void> {
    const rt = createRuntime(this.env);
    if (batch.queue.startsWith("notify")) return consumeNotify(batch, rt);
    if (batch.queue.startsWith("reindex")) return consumeReindex(batch, rt);
    throw new Error(`validator consumes no queue named ${batch.queue}`);
  }

  signScopeIndex(request: unknown) {
    return signEntrypoints(createRuntime(this.env)).signScopeIndex(request);
  }

  signPrivateEntries(request: unknown) {
    return signEntrypoints(createRuntime(this.env)).signPrivateEntries(request);
  }

  signAndWriteRoot(request: unknown) {
    return signEntrypoints(createRuntime(this.env)).signAndWriteRoot(request);
  }
}

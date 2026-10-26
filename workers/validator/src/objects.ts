import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createRuntime, type ObjectEnv } from "./bindings";
import { runPipeline, type StepRunner, type WorkflowParams } from "./workflow/pipeline";

export class ValidatePackWorkflow extends WorkflowEntrypoint<ObjectEnv, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    await runPipeline(createRuntime(this.env), step as unknown as StepRunner, event.payload);
  }
}

export class SandboxA extends DurableObject {}

export class SandboxB extends DurableObject {}

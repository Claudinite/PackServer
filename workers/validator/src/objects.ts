import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

export class ValidatePackWorkflow extends WorkflowEntrypoint {
  async run(): Promise<never> {
    throw new Error("ValidatePackWorkflow has no steps yet");
  }
}

export class SandboxA extends DurableObject {}

export class SandboxB extends DurableObject {}

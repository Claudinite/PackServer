import { RELEASE_HEADER, StartValidationRequest, StartValidationResponse } from "@packserver/schema";
import type { z } from "zod";

type StartRequest = z.infer<typeof StartValidationRequest>;

/** Where the validator takes a run; no hostname of its own is public, so the origin is only a placeholder. */
export const VALIDATOR_START_URL = "http://validator.internal/internal/runs";

/** The one thing a run start needs from the validator's service binding. */
export interface ValidatorService {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export type Dispatch =
  | { ok: true; workflowInstanceId: string }
  /** The validator did not take the run; it stays queued and a replay of the start retries. */
  | { ok: false; why: "not-accepting" | "unreachable" | "refused" };

/**
 * Asks the validator to start the workflow for a run. The request names the run; the validator
 * reads everything else, the instant it may begin included, from `validation_runs`.
 */
export async function startValidation(validator: ValidatorService, releaseId: string, request: StartRequest): Promise<Dispatch> {
  let response: Response;
  try {
    response = await validator.fetch(VALIDATOR_START_URL, {
      method: "POST",
      headers: { "content-type": "application/json", [RELEASE_HEADER]: releaseId },
      body: JSON.stringify(StartValidationRequest.parse(request)),
    });
  } catch {
    return { ok: false, why: "unreachable" };
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    await response.arrayBuffer();
    return { ok: false, why: "not-accepting" };
  }
  const parsed = StartValidationResponse.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success) return { ok: false, why: "unreachable" };
  return parsed.data.ok ? { ok: true, workflowInstanceId: parsed.data.workflow_instance_id } : { ok: false, why: "refused" };
}

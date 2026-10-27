import type { ApiResponse } from "../drivers/driver";
import { InfrastructureError } from "./errors";
import { NotFound, Refusal, type RefusalReason } from "./outcomes";
import type { Sensitive, User } from "./types";
import { callerOf } from "./areas/users";

/** What a lifecycle action answers once the HTTP shape is hidden: success, a missing resource, or a refusal thrown for the matchers. */
export async function lifecycleCall(
  by: User | undefined,
  what: string,
  action: string,
  target: string,
  path: string,
  json: unknown,
  o: Sensitive = {},
): Promise<Record<string, unknown> | NotFound> {
  if (!by) throw new InfrastructureError(`${what}: say who acts with { by }`);
  const caller = callerOf(by);
  const res: ApiResponse = await caller.call({ method: "POST", path, json, headers: await caller.assertionHeaders(action, o, target) });
  if (res.status === 404) return new NotFound();
  if (res.status >= 200 && res.status < 300) return res.json() as Record<string, unknown>;
  let body: { reason?: RefusalReason; message?: string };
  try {
    body = res.json() as typeof body;
  } catch {
    throw new InfrastructureError(`${what}: expected a refusal or success, got ${res.status} ${res.text.slice(0, 120)}`);
  }
  if (!body.reason) throw new InfrastructureError(`${what}: got ${res.status} without a reason: ${res.text.slice(0, 120)}`);
  throw new Refusal(body.reason, body.message === undefined ? {} : { message: body.message });
}

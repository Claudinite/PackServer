import { z } from "zod";

/** A queue message: `{schema: n, …fields}`. */
export function queueMessage<S extends z.ZodRawShape>(shape: S) {
  return z.object({ schema: z.number().int().positive(), ...shape });
}

export type QueueAcceptance<T> =
  | { ok: true; message: T }
  | { ok: false; reason: "malformed" | "schema.unsupported"; schema?: number };

/** A consumer at schema n accepts n and n+1; anything else is refused, not guessed at. */
export function acceptQueueMessage<T extends { schema: number }>(
  consumerSchema: number,
  message: z.ZodType<T>,
  raw: unknown,
): QueueAcceptance<T> {
  const head = z.object({ schema: z.number().int().positive() }).safeParse(raw);
  if (!head.success) return { ok: false, reason: "malformed" };
  const { schema } = head.data;
  if (schema !== consumerSchema && schema !== consumerSchema + 1) {
    return { ok: false, reason: "schema.unsupported", schema };
  }
  const parsed = message.safeParse(raw);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: "malformed", schema };
}

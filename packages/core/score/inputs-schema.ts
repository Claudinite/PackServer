import { z } from "zod";

/**
 * What the score reads of a tree, taken where the archive is already decompressed so the Worker
 * never decompresses one (REQ-VAL-022): every path and its executable bit, and the text of the few
 * files the rules touch.
 */
export const ScoreInputs = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), executable: z.boolean(), text: z.string().nullable() })),
});
export type ScoreInputs = z.infer<typeof ScoreInputs>;

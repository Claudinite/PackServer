import { PackVersion } from "@packserver/schema";
import { z } from "zod";
import { BUG_TYPES, SEVERITIES } from "./constants.ts";

const text = (max: number) => z.string().trim().min(1).max(max);

const common = {
  version: PackVersion,
  severity: z.enum(SEVERITIES),
  title: text(140),
  repro: text(8000),
  environment: text(2000),
  attachment_ids: z.array(z.string().min(1).max(64)).max(5).default([]),
};

export const ReportInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bug"), type: z.enum(BUG_TYPES), ...common }).strict(),
  z.object({ kind: z.literal("security"), ...common }).strict(),
]);
export type ReportInput = z.infer<typeof ReportInput>;

export const StatusInput = z
  .object({ status: z.enum(["open", "acknowledged", "fixed", "wont_fix", "duplicate"]), fixed_in: PackVersion.optional() })
  .strict()
  .refine((v) => (v.status === "fixed") === (v.fixed_in !== undefined), { message: "fixed_in goes with the status fixed and nothing else" });
export type StatusInput = z.infer<typeof StatusInput>;

export const IssueLinkInput = z.object({ issue_url: z.string().max(300) }).strict();

export const AdvisoryInput = z
  .object({
    summary: text(2000),
    severity: z.enum(SEVERITIES).optional(),
    versions: z.array(PackVersion).min(1).max(200),
    fixed_in: PackVersion.optional(),
  })
  .strict();
export type AdvisoryInput = z.infer<typeof AdvisoryInput>;

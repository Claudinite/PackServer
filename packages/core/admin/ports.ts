import type { R2Read, Workflow } from "@packserver/ports";
import type { Audit } from "../audit/index.ts";
import type { ProofPorts } from "../scopes/proofs/context.ts";

/** Everything the admin app's decisions touch: the registry database, the stored reports, the validation workflow and the audit record. */
export interface AdminPorts extends ProofPorts {
  /** The `validation-reports` bucket, read-only. */
  validationReports: R2Read;
  /** The `VALIDATE_PACK` binding, used only to wake an instance waiting for a human. */
  workflows: Workflow;
  audit: Audit;
}

/** A person admitted through Cloudflare Access; they have no account of their own. */
export interface AdminIdentity {
  email: string;
  sub: string;
}

export const actorOf = (admin: AdminIdentity) => ({ kind: "admin" as const, id: admin.email });

export const MAX_REASON = 1000;

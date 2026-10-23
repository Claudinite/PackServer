import { stubModule } from "../errors";

/** The audit chain and its transparency log. */
export interface AuditModule {
  audit: {
    for(subject: unknown): Promise<unknown[]>;
    batches(): Promise<unknown[]>;
    heads(): Promise<unknown[]>;
    verify(): Promise<"intact" | { mismatch: unknown }>;
    tamper(batch: unknown, how: { drop: true } | { alter: true }): void;
  };
  rekor: { entries(): Promise<unknown[]> };
}

export const createAudit = (): AuditModule => ({ audit: stubModule("audit"), rekor: stubModule("rekor") });

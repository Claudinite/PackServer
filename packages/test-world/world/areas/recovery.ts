import type { Driver } from "../../drivers/driver";
import { InfrastructureError } from "../errors";
import { Refusal } from "../outcomes";
import type { User } from "../types";

const ADMIN = { email: "admin@example.test", sub: "admin-1" };

/** The admin queue of delayed account recoveries (REQ-ADMIN-007). */
export interface RecoveryModule {
  recoveries: {
    /** Completes the person's open recovery as an admin; refused while its delay has not passed. */
    approve(user: User): Promise<void>;
    /** The addresses with a recovery waiting. */
    queue(): Promise<string[]>;
  };
}

export function createRecoveries(driver: Driver): RecoveryModule {
  const call = async (method: string, path: string) => {
    const access = driver.fakes?.workers.access;
    if (!access) throw new InfrastructureError(`the ${driver.kind} driver has no fake Access: an admin cannot be signed in`);
    const assertion = await access.call<string>("assert", ADMIN);
    return driver.http.request({ surface: "admin", method, path, headers: { "cf-access-jwt-assertion": assertion } });
  };
  const queue = async () => {
    const res = await call("GET", "/admin/recoveries");
    if (res.status !== 200) throw new InfrastructureError(`recoveries.queue: ${res.status} ${res.text.slice(0, 120)}`);
    return (res.json() as { recoveries: Array<{ id: string; email: string }> }).recoveries;
  };
  return {
    recoveries: {
      queue: async () => (await queue()).map((r) => r.email),
      async approve(user) {
        const found = (await queue()).find((r) => r.email === user.email);
        if (!found) throw new InfrastructureError(`recoveries.approve: no recovery is waiting for ${user.email}`);
        const res = await call("POST", `/admin/recoveries/${found.id}/approve`);
        if (res.status === 200) return;
        const body = res.json() as { reason?: string };
        throw new Refusal("forbidden", { message: body.reason ?? "refused" });
      },
    },
  };
}

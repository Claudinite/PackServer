import type { Driver } from "../drivers/driver";
import { Aliases } from "./alias";
import { createAccess } from "./areas/access";
import { createAdmin } from "./areas/admin";
import { createAgents } from "./areas/agents";
import { createAuditModule } from "./areas/audit";
import { createCommunity } from "./areas/community";
import { createGitHub } from "./areas/github";
import { createMember } from "./areas/member";
import { createModeration } from "./areas/moderation";
import { createOperator } from "./areas/operator";
import { createPublishing } from "./areas/publishing";
import { createScopes } from "./areas/scopes";
import { createSearch } from "./areas/search";
import { createTelemetry } from "./areas/telemetry";
import { createUsers } from "./areas/users";
import { createValidation } from "./areas/validation";
import { createClock } from "./clock";
import { createCi } from "./ci-workflow";
import { InfrastructureError } from "./errors";
import { createMail } from "./mail";
import { createPlatform } from "./platform";
import { filterInvocations, type InvocationFilter, type InvocationView, type RecorderView } from "./recorder";

/** One per scenario: owns the driver handle, the clock, the recorder view, the aliases and the area modules. */
export function createWorld(driver: Driver, title: string) {
  const aliases = new Aliases(title, driver.aliasSalt);
  const recorder: RecorderView = {
    async invocations(filter: InvocationFilter = {}): Promise<InvocationView[]> {
      if (!driver.recorder) throw new InfrastructureError(`the ${driver.kind} driver has no recorder`);
      return filterInvocations(driver.recorder.invocations(filter), filter);
    },
  };
  const people = createUsers(driver, aliases);
  return {
    driver,
    ...people,
    ...createScopes(driver, aliases, people),
    ...createPublishing(),
    ...createValidation(),
    ...createAccess(driver),
    ...createCommunity(),
    ...createModeration(),
    ...createAdmin(),
    ...createMember(),
    ...createAgents(),
    ...createGitHub(driver),
    ...createAuditModule(driver),
    ...createSearch(driver, aliases),
    ...createTelemetry(),
    ...createCi(driver, (name) => aliases.alias(name)),
    operator: createOperator(driver),
    clock: createClock(driver),
    mail: createMail(driver),
    platform: createPlatform(driver),
    recorder,
    alias: (name: string) => aliases.alias(name),
    unalias: (text: string) => aliases.unalias(text),
    async dispose(): Promise<void> {},
  };
}

export type World = ReturnType<typeof createWorld>;

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
import { createOperator, createProbe } from "./areas/operator";
import { createReportsModule } from "./areas/reports";
import { createRollups } from "./areas/rollups";
import { createPublishing } from "./areas/publishing";
import { createRecoveries } from "./areas/recovery";
import { createScopes } from "./areas/scopes";
import { createSearch } from "./areas/search";
import { createTelemetry } from "./areas/telemetry";
import { createUsers } from "./areas/users";
import { createValidation } from "./validation";
import { createPublishFlow } from "./publishing";
import { createClock } from "./clock";
import { createCi } from "./ci-workflow";
import { InfrastructureError } from "./errors";
import { createMail } from "./mail";
import { createPlatform } from "./platform";
import { createRegistry } from "./registry";
import { createDns } from "./proofs";
import { createTrustedPublishers } from "./trusted-publishers";
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
  const scopes = createScopes(driver, aliases, people);
  const ci = createCi(driver, (name) => aliases.alias(name));
  const validation = createValidation(driver);
  const publishFlow = createPublishFlow(driver, aliases, scopes, ci, validation.ensureEngines);
  const undo: Array<() => Promise<void>> = [];
  return {
    driver,
    ...people,
    ...scopes,
    ...createPublishing(),
    ...validation.module,
    ...publishFlow,
    ...createProbe(driver, ci, (name) => aliases.alias(name), publishFlow.publishFromCi),
    ...createAccess(driver, aliases),
    ...createCommunity(driver, aliases),
    ...createModeration(),
    ...createReportsModule(driver, aliases),
    ...createAdmin(driver, (restore) => void undo.push(restore), aliases),
    ...createRecoveries(driver),
    ...createMember(driver),
    ...createAgents(driver, aliases),
    ...createGitHub(driver),
    dns: createDns(driver, aliases),
    ...createAuditModule(driver),
    ...createSearch(driver, aliases),
    ...createRegistry(driver),
    ...createTelemetry(),
    ...createRollups(driver),
    ...ci,
    ...createTrustedPublishers(driver, aliases),
    operator: createOperator(driver),
    clock: createClock(driver),
    mail: createMail(driver),
    platform: createPlatform(driver),
    recorder,
    alias: (name: string) => aliases.alias(name),
    unalias: (text: string) => aliases.unalias(text),
    /** Puts back what a verb changed that the next scenario would otherwise inherit. */
    async dispose(): Promise<void> {
      for (const restore of undo.splice(0).reverse()) await restore();
    },
  };
}

export type World = ReturnType<typeof createWorld>;

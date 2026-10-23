import { stubModule } from "../errors";
import type { Agent, User } from "../types";

/** MCP clients. */
export interface AgentsModule {
  agents: { anonymous(): Agent; withToken(token: unknown): Promise<Agent>; oauth(user: User): Promise<Agent> };
}

export const createAgents = (): AgentsModule => ({ agents: stubModule("agents") });

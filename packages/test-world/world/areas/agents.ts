import type { ApiRequest, Driver } from "../../drivers/driver";
import { McpClient } from "../../drivers/mcp";
import type { Aliases } from "../alias";
import { InfrastructureError, stubModule } from "../errors";
import { Refusal } from "../outcomes";
import type { PackHandle } from "../packs";
import type { Agent, User } from "../types";

/** What a tool answered: the tool's own JSON, and whether it called the answer an error. */
export interface ToolAnswer {
  ok: boolean;
  // A tool's JSON is the contract under test; scenarios read it by path and the assertion is what types it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
}

export interface AgentSearchFilters {
  category?: string;
  part?: string;
  hasRepository?: boolean;
  verifiedOnly?: boolean;
  verifiedDomains?: string[];
  limit?: number;
}

/** What a burst of calls met: how many were answered, how many refused, and what the refusals said. */
export interface Flood {
  answered: number;
  refused: number;
  refusal: Refusal | null;
  /** The refusal's body names the limit, never a pack. */
  refusalMentionsPack: boolean;
}

export interface McpAgent extends Agent {
  search(query: string, filters?: AgentSearchFilters): Promise<ToolAnswer>;
  categories(): Promise<ToolAnswer>;
  pack(pack: PackHandle | string, version?: string): Promise<ToolAnswer>;
  download(pack: PackHandle | string, version?: string): Promise<ToolAnswer>;
  /** The descriptions `tools/list` gives each tool. */
  describedTools(): Promise<Record<string, string>>;
  /** The same agent from another network address. */
  from(ip: string): McpAgent;
  /** The same agent presenting a read token. */
  bearing(token: string | { value: string }): McpAgent;
  /** Sends `count` calls in quick succession and reports how many the limit let through. */
  flood(count: number): Promise<Flood>;
}

export interface ExcerptSeed {
  readme?: string;
  rules?: string;
  skills?: Array<{ name: string; description: string }>;
}

/** MCP clients, and the seeding of what `get_pack` reads that no other area writes yet. */
export interface AgentsModule {
  agents: {
    anonymous(): McpAgent;
    withToken(token: unknown): Promise<Agent>;
    oauth(user: User): Promise<Agent>;
    /** Paths of the strings in `body` that hold `needle` outside every `publisher_text` field. */
    outsidePublisherText(body: unknown, needle: string): string[];
    /** The prose excerpts the validator will publish beside `meta.json`. */
    seedExcerpts(pack: PackHandle, version: string, seed: ExcerptSeed): Promise<void>;
    /** The feature flag that turns the Preview adopt line into the real command; absent unsets it. */
    setAdoptVersion(version: string | null): Promise<void>;
  };
}

function outside(value: unknown, needle: string, path: string, inside: boolean): string[] {
  if (typeof value === "string") return !inside && value.includes(needle) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => outside(v, needle, `${path}[${i}]`, inside));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => outside(v, needle, `${path}.${k}`, inside || k === "publisher_text"));
  }
  return [];
}

/** Calls in flight at once during a burst: enough to finish a few hundred inside the minute the limit counts. */
const BURST_WIDTH = 50;

/** Every agent starts at an address of its own, so one scenario's calls never spend another's minute. */
function freshAddress(): string {
  const [a = 0, b = 0] = crypto.getRandomValues(new Uint8Array(2));
  return `198.18.${a}.${b}`;
}

export function createAgents(driver: Driver, aliases: Aliases): AgentsModule {
  const later = stubModule<Pick<AgentsModule["agents"], "withToken" | "oauth">>("agents");
  const nameOf = (pack: PackHandle | string) => (typeof pack === "string" ? aliases.alias(pack) : pack.systemName);

  function agent(ip: string, bearer: string | undefined): McpAgent {
    const headers = (extra: Record<string, string> = {}) => ({ "cf-connecting-ip": ip, ...extra });
    const send = (req: ApiRequest) => driver.http.request({ ...req, headers: headers(req.headers) });
    let client: Promise<McpClient> | undefined;
    const connected = () =>
      (client ??= (async () => {
        const c = new McpClient(send, bearer ? { bearer } : {});
        await c.initialize();
        return c;
      })());
    const call = async (name: string, args: object): Promise<ToolAnswer> => {
      const result = await (await connected()).callTool(name, args);
      const text = result.content.find((c) => c.type === "text")?.text;
      if (text === undefined) throw new InfrastructureError(`${name} answered no text`);
      return { ok: !result.isError, body: JSON.parse(aliases.unalias(text)) as ToolAnswer["body"] };
    };
    return {
      async tools() {
        return (await (await connected()).listTools()).map((t) => t.name).sort();
      },
      async describedTools() {
        return Object.fromEntries((await (await connected()).listTools()).map((t) => [t.name, t.description ?? ""]));
      },
      search: (query, f = {}) =>
        call("search_packs", {
          query,
          ...(f.category !== undefined ? { category: f.category } : {}),
          ...(f.part !== undefined ? { part: f.part } : {}),
          ...(f.hasRepository !== undefined ? { has_repository: f.hasRepository } : {}),
          ...(f.verifiedOnly !== undefined ? { verified_only: f.verifiedOnly } : {}),
          ...(f.verifiedDomains !== undefined ? { verified_domains: f.verifiedDomains } : {}),
          ...(f.limit !== undefined ? { limit: f.limit } : {}),
        }),
      categories: () => call("list_categories", {}),
      pack: (pack, version) => call("get_pack", { name: nameOf(pack), ...(version !== undefined ? { version } : {}) }),
      download: (pack, version) => call("get_download", { name: nameOf(pack), ...(version !== undefined ? { version } : {}) }),
      from: (address) => agent(address, bearer),
      bearing: (token) => agent(ip, typeof token === "string" ? token : token.value),
      async flood(count) {
        const out: Flood = { answered: 0, refused: 0, refusal: null, refusalMentionsPack: false };
        for (let sent = 0; sent < count; sent += BURST_WIDTH) {
          const wave = await Promise.all(
            Array.from({ length: Math.min(BURST_WIDTH, count - sent) }, (_, i) =>
              send({
                surface: "mcp",
                method: "POST",
                path: "/mcp",
                headers: { accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
                body: { jsonrpc: "2.0", id: sent + i + 1, method: "ping" },
              }),
            ),
          );
          for (const res of wave) {
            if (res.status === 200) out.answered++;
            else if (res.status === 429) {
              const body = JSON.parse(res.text) as { retry_after_s?: number };
              out.refused++;
              out.refusal ??= new Refusal("rate-limited", body.retry_after_s === undefined ? {} : { retryAfterS: body.retry_after_s });
              if (/pack|not.?found/i.test(res.text)) out.refusalMentionsPack = true;
            } else throw new InfrastructureError(`a burst call answered ${res.status}: ${res.text.slice(0, 200)}`);
          }
        }
        return out;
      },
    };
  }

  const storage = async () => {
    if (!driver.storage || !driver.capabilities.has("storage")) throw new InfrastructureError(`the ${driver.kind} driver cannot seed: it has no storage seam`);
    return driver.storage();
  };

  return {
    agents: {
      anonymous: () => agent(freshAddress(), undefined),
      withToken: (token) => later.withToken(token),
      oauth: (user) => later.oauth(user),
      outsidePublisherText: (body, needle) => outside(body, needle, "", false),
      async seedExcerpts(pack, version, seed) {
        const { packsPublic } = await storage();
        await packsPublic.put(`${pack.systemName}/${version}/excerpts.json`, JSON.stringify(seed));
      },
      async setAdoptVersion(version) {
        const { db } = await storage();
        const statements =
          version === null
            ? [db.prepare("DELETE FROM feature_flags WHERE key = 'cn_min_adopt_version'")]
            : [db.prepare("INSERT OR REPLACE INTO feature_flags (key, value, security, updated_at) VALUES ('cn_min_adopt_version', ?, 0, ?)").bind(JSON.stringify(version), new Date().toISOString())];
        await db.batch(statements);
      },
    },
  };
}

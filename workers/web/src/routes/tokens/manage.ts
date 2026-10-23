import { grantCovers, listTokens, mintToken, revokeToken, type MintInput, type MintRefusal } from "@packserver/core/tokens";
import { authenticateToken, refusal, requireAssertion, requireSession, sessionCsrf } from "@packserver/http";
import { PackName } from "@packserver/schema";
import { Hono } from "hono";
import { runtimeOf, sessionPorts, siteOriginOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

const NO_STORE = { "cache-control": "no-store" };
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

const tokenPorts = (c: Parameters<typeof runtimeOf>[0]) => {
  const { d1, clock, rng } = runtimeOf(c).ports;
  return { d1, clock, rng };
};

interface Parsed {
  input: Omit<MintInput, "userId">;
}

/** Only `read` tokens exist; naming any other kind, or a restriction that is not one pack or one scope, is a malformed request. */
function parseMint(body: unknown): Parsed | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "format: a JSON object is required.";
  const b = body as Record<string, unknown>;
  if (b.kind !== undefined && b.kind !== "read") return "kind: only read tokens exist.";
  const hasPack = b.pack !== undefined;
  if (hasPack === (b.scope !== undefined)) return "restriction: name exactly one of pack or scope.";
  let scope: string;
  let pack: string | undefined;
  if (hasPack) {
    if (typeof b.pack !== "string" || !PackName.safeParse(b.pack).success) return "restriction: pack must look like @scope/name.";
    [scope, pack] = b.pack.slice(1).split("/") as [string, string];
  } else {
    if (typeof b.scope !== "string" || !/^@[a-z0-9-]+$/.test(b.scope)) return "restriction: scope must look like @scope.";
    scope = b.scope.slice(1);
  }
  if (b.lifetime_days !== undefined && typeof b.lifetime_days !== "number") return "lifetime: lifetime_days must be a number.";
  if (b.cidr !== undefined && (!Array.isArray(b.cidr) || !b.cidr.every((c) => typeof c === "string"))) return "cidr: cidr must be a list of strings.";
  if (b.label !== undefined && typeof b.label !== "string") return "label: label must be text.";
  return {
    input: {
      scope,
      ...(pack === undefined ? {} : { pack }),
      ...(b.lifetime_days === undefined ? {} : { lifetimeDays: b.lifetime_days as number }),
      ...(b.cidr === undefined ? {} : { cidr: b.cidr as string[] }),
      ...(b.label === undefined ? {} : { label: b.label as string }),
    },
  };
}

const REFUSAL_TEXT: Record<Exclude<MintRefusal, "not-found">, string> = {
  lifetime: "lifetime: a token lasts 1 to 365 whole days (7 by default).",
  cidr: "cidr: use up to 16 addresses or blocks such as 10.0.0.0/8.",
  label: "label: at most 80 characters, no control characters.",
};

/** Mints a read token. Browser session only: a token is never accepted here (REQ-PUB-012, REQ-PUB-031). */
routes.post(
  "/tokens",
  requireSession(),
  sessionCsrf<WebEnv>(siteOriginOf),
  requireAssertion<WebEnv>("token.mint", { ports: (c) => sessionPorts(runtimeOf(c)), environment: (c) => runtimeOf(c).environment }),
  async (c) => {
    const parsed = parseMint(await c.req.json().catch(() => null));
    if (typeof parsed === "string") return refusal("forbidden", { status: 422, message: parsed });
    const out = await mintToken(tokenPorts(c), { userId: c.get("session")!.record.user_id, ...parsed.input });
    if (!out.ok) return out.reason === "not-found" ? notFound() : refusal("forbidden", { status: 422, message: REFUSAL_TEXT[out.reason] });
    return c.json({ token: out.token, ...out.view }, 201, NO_STORE);
  },
);

/** The signed-in person's tokens: never the values. */
routes.get("/tokens", requireSession(), async (c) => {
  return c.json({ tokens: await listTokens(tokenPorts(c), c.get("session")!.record.user_id) }, 200, NO_STORE);
});

routes.delete("/tokens/:id", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), async (c) => {
  const revoked = await revokeToken(tokenPorts(c), c.get("session")!.record.user_id, c.req.param("id"));
  return revoked ? c.json({ revoked: true }, 200, NO_STORE) : notFound();
});

/**
 * Lets CI ask whether its token reads a pack before relying on it. A pack outside the token's
 * restriction answers exactly as a pack that does not exist.
 */
routes.get(
  "/tokens/check/:scope/:name",
  authenticateToken<WebEnv>((c) => tokenPorts(c)),
  (c) => {
    const grant = c.get("token");
    if (!grant) return refusal("signed-out");
    const scope = c.req.param("scope") ?? "";
    const pack = c.req.param("name") ?? "";
    if (!scope.startsWith("@") || !grantCovers(grant, { scope: scope.slice(1), pack })) return notFound();
    return c.json({ readable: true }, 200, NO_STORE);
  },
);

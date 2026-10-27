import { expect, Refusal, scenario, type ScenarioOpts, type World } from "@packserver/test-world";

type McpAgent = ReturnType<World["agents"]["anonymous"]>;

// OAuth and the privileged tools.
const oauth: ScenarioOpts = { needs: ["storage", "fakes", "clock"], tags: ["agent"] };
const PUBLIC_TOOLS = ["get_download", "get_pack", "list_categories", "search_packs"];

/** A signed-in person, old enough for a star to count, who may read one private pack through a read token. */
async function reader(world: World, handle: string, age = "3d") {
  const person = await world.users.create({ handle });
  await person.signIn();
  await world.community.setAge(person, age);
  return person;
}

async function starsFromAgent(world: World) {
  const ann = await reader(world, "dee");
  const pack = await world.packs.public("@acme/starred");
  const agent = await world.agents.oauth(ann);

  expect(await world.community.stars(pack, ann)).toEqual({ count: 0, starred: false });
  expect((await agent.star(pack)).body).toMatchObject({ id: pack.name, starred: true, stars: 1 });
  expect((await agent.star(pack)).body).toMatchObject({ stars: 1 });
  expect(await world.community.stars(pack, ann)).toEqual({ count: 1, starred: true });
  const missing = await agent.star("@acme/none");
  expect(missing.ok).toBe(false);
}

scenario("IT-MCP-008 Privileged tools are not listed to unauthorised callers", async (world) => {
  const ann = await reader(world, "ann");
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  await world.tokens.seedOwner(ann, secret);
  const token = await ann.tokens.mint({ read: secret });

  expect(await world.agents.anonymous().tools()).toEqual(PUBLIC_TOOLS);
  expect(await world.agents.withToken(token).tools()).toEqual([...PUBLIC_TOOLS, "list_my_packs"].sort());
  expect(await (await world.agents.oauth(ann, { scopes: ["packs:read"] })).tools()).toEqual([...PUBLIC_TOOLS, "list_my_packs"].sort());
  expect(await (await world.agents.oauth(ann)).tools()).toEqual([...PUBLIC_TOOLS, "list_my_packs", "star_pack"].sort());
}, oauth);

scenario("IT-MCP-018 An unlisted tool cannot be called by name", async (world) => {
  const ann = await reader(world, "ann");
  const pack = await world.packs.public("@acme/gcp");
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  await world.tokens.seedOwner(ann, secret);
  const holder = world.agents.withToken(await ann.tokens.mint({ read: secret }));
  const reading = await world.agents.oauth(ann, { scopes: ["packs:read"] });
  const anon = world.agents.anonymous();

  for (const tool of ["star_pack", "list_my_packs"]) {
    expect(await world.agents.callUnlistedTool(anon, tool, { name: pack.systemName })).toMatchObject({ reason: "signed-out" });
  }
  // A credential that is known but lacks the scope is told which scope, not that it must sign in.
  for (const caller of [holder, reading]) {
    expect(await world.agents.callUnlistedTool(caller, "star_pack", { name: pack.systemName })).toMatchObject({ reason: "scope" });
  }
  expect(await world.agents.callUnlistedTool(anon, "no_such_tool")).toMatchObject({ reason: "unknown-tool" });
  expect(await world.community.stars(pack, ann)).toEqual({ count: 0, starred: false });
  await starsFromAgent(world);
}, oauth);

scenario("IT-MCP-009 OAuth: unauthenticated callers are pointed at resource metadata, PKCE S256, audience binding", async (world) => {
  const ann = await reader(world, "ann");
  const bea = world.users.newcomer({ via: "passkey" });

  const challenge = await world.agents.callUnlistedTool(world.agents.anonymous(), "list_my_packs");
  expect(challenge).toMatchObject({ reason: "signed-out" });
  expect(world.agents.authServer.advertisesMetadata(challenge as Refusal)).toBe(true);

  const { resource, server } = await world.agents.authServer.metadata();
  expect(resource).toMatchObject({ resource: world.agents.authServer.resource, scopes_supported: ["packs:read"] });
  expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  expect(server.scopes_supported).toEqual(["packs:read", "packs:write"]);
  expect(server.client_id_metadata_document_supported).toBe(true);

  const client = await world.agents.authServer.register();
  if (client instanceof Refusal) throw new Error("registration refused");
  for (const [person, via] of [[ann, "github"], [bea, "passkey"]] as const) {
    const session = await person.signIn({ via });
    const consent = await client.authorize(person, { session });
    if (consent instanceof Refusal) throw new Error(`no consent page: ${consent.detail.message}`);
    const granted = await consent.approve();
    if (granted instanceof Refusal) throw new Error(`not granted: ${granted.detail.message}`);
    const tokens = await granted.exchange();
    if (tokens instanceof Refusal) throw new Error(`no token: ${tokens.detail.message}`);
    expect((await world.agents.holding(tokens).mine()).ok).toBe(true);
  }

  expect(await client.authorize(ann, { pkce: "plain" })).toBeInstanceOf(Refusal);
  expect(await client.authorize(ann, { pkce: "none" })).toBeInstanceOf(Refusal);
  expect(await world.agents.authServer.register({ confidential: true })).toBeInstanceOf(Refusal);
  expect(await client.authorize(ann, { resource: "foreign" })).toBeInstanceOf(Refusal);
  const consent = await client.authorize(ann);
  if (consent instanceof Refusal) throw new Error("no consent page");
  const granted = await consent.approve();
  if (granted instanceof Refusal) throw new Error("not granted");
  expect(await granted.exchange({ resource: "foreign" })).toBeInstanceOf(Refusal);
  expect(await granted.exchange({ verifier: "wrong" })).toBeInstanceOf(Refusal);
}, oauth);

scenario("IT-MCP-017 The authorization server hardens redirects, codes, registration and the consent page", async (world) => {
  const ann = await reader(world, "ann");
  const client = await world.agents.authServer.register();
  if (client instanceof Refusal) throw new Error("registration refused");
  const session = await ann.signIn();

  expect(await client.authorize(ann, { session, redirect: "other-path" })).toBeInstanceOf(Refusal);
  expect(await client.authorize(ann, { session, redirect: "extra-query" })).toBeInstanceOf(Refusal);
  expect(await client.authorize(ann, { session, state: null })).toBeInstanceOf(Refusal);
  const grant = async () => {
    const consent = await client.authorize(ann, { session });
    if (consent instanceof Refusal) throw new Error("the exact redirect was refused");
    const granted = await consent.approve();
    if (granted instanceof Refusal) throw new Error("not granted");
    return granted;
  };

  const once = await grant();
  expect(once.redirect.origin + once.redirect.pathname).toBe(client.redirectUri);
  expect(await once.exchange()).not.toBeInstanceOf(Refusal);
  expect(await once.exchange()).toBeInstanceOf(Refusal);

  const tokens = await (await grant()).exchange();
  if (tokens instanceof Refusal) throw new Error("no token");
  // A refresh token works once; presenting it again ends the whole grant, the newer token included.
  const rotated = await tokens.refresh();
  if (rotated instanceof Refusal) throw new Error("the first refresh was refused");
  expect(await tokens.refresh()).toBeInstanceOf(Refusal);
  expect(await rotated.refresh()).toBeInstanceOf(Refusal);
  expect(await world.agents.authServer.grants(ann, session)).toEqual([]);
  expect(await world.agents.authServer.auditedGrants()).toEqual(expect.arrayContaining(["token.minted", "token.revoked", "token.refused"]));

  // Metadata documents: HTTPS only, and a redirect is never followed.
  const plain = world.agents.authServer.documented({ scheme: "http" });
  expect(await plain.authorize(ann, { session })).toBeInstanceOf(Refusal);
  const hop = world.agents.authServer.redirected();
  expect(await hop.authorize(ann, { session })).toBeInstanceOf(Refusal);
  const wire = await world.recorder.invocations({ raw: true });
  expect(wire.filter((i) => i.target === hop.host)).not.toEqual([]);
  expect(wire.filter((i) => i.target === plain.host)).toEqual([]);

  const documented = world.agents.authServer.documented({ name: "<b>Trusted</b>", logo: true });
  const shown = await documented.authorize(ann, { session });
  if (shown instanceof Refusal) throw new Error("the documented client was refused");
  expect(shown.leadsWith).toBe(`${documented.origin} asks to connect`);
  expect(shown.page).toContain("&lt;b&gt;Trusted&lt;/b&gt;");
  expect(shown.page).toContain("unverified client");
  expect(shown.page).not.toContain("<b>Trusted</b>");
  expect(shown.page).not.toContain("logo");
  expect(shown.page.indexOf(documented.origin)).toBeLessThan(shown.page.indexOf("&lt;b&gt;"));

  const burst = [];
  for (let i = 0; i < 30; i++) burst.push(await world.agents.authServer.register({ from: "198.19.7.7" }));
  expect(burst.some((r) => r instanceof Refusal && r.reason === "rate-limited")).toBe(true);
  expect(burst[0]).not.toBeInstanceOf(Refusal);
  await consentIsSafe(world);
}, oauth);

async function consentIsSafe(world: World) {
  const ann = await reader(world, "cy");
  const client = await world.agents.authServer.fresh().register();
  if (client instanceof Refusal) throw new Error("registration refused");
  const session = await ann.signIn();

  const signedOut = await client.authorizeSignedOut();
  expect(signedOut).toMatchObject({ reason: "signed-out" });

  const forged = await client.authorize(ann, { session });
  if (forged instanceof Refusal) throw new Error("no consent page");
  expect(forged.refusesFraming).toBe(true);
  for (const csrf of ["none", "foreign"] as const) expect(await forged.approve({ csrf })).toBeInstanceOf(Refusal);

  const narrowed = await client.authorize(ann, { session, scopes: ["packs:read", "packs:write"] });
  if (narrowed instanceof Refusal) throw new Error("no consent page");
  const granted = await narrowed.approve({ scopes: ["packs:read"] });
  if (granted instanceof Refusal) throw new Error("not granted");
  const tokens = await granted.exchange();
  if (tokens instanceof Refusal) throw new Error("no token");
  expect(tokens.scopes).toEqual(["packs:read"]);
  expect(await world.agents.holding(tokens).tools()).toEqual([...PUBLIC_TOOLS, "list_my_packs"].sort());

  const asked = await client.authorize(ann, { session, scopes: ["packs:read"] });
  if (asked instanceof Refusal) throw new Error("no consent page");
  const widened = await asked.approve({ scopes: ["packs:read", "packs:write"] });
  if (widened instanceof Refusal) throw new Error("not granted");
  const more = await widened.exchange();
  if (more instanceof Refusal) throw new Error("no token");
  expect(more.scopes).toEqual(["packs:read"]);

  const declined = await client.authorize(ann, { session });
  if (declined instanceof Refusal) throw new Error("no consent page");
  expect(await declined.deny()).toEqual({ accessDenied: true });
}

scenario("IT-MCP-010 psr_ tokens work on MCP; third-party tokens never", async (world) => {
  const ann = await reader(world, "ann");
  const secret = await world.packs.public("@acme/secret", { visibility: "private" });
  await world.tokens.seedOwner(ann, secret);
  await world.search.list(secret, { pitch: "Internal tooling", category: "other" });
  const token = await ann.tokens.mint({ read: secret });

  const answered = await world.agents.withToken(token).pack(secret);
  expect(answered.ok).toBe(true);
  expect(answered.body).toMatchObject({ id: secret.name, visibility: "private" });
  expect((await world.agents.withToken(token).download(secret, "1.0.0")).body).toMatchObject({ requires_bearer: true });

  const before = (await world.recorder.invocations({ raw: true })).length;
  for (const bearer of [await world.agents.thirdPartyToken("github"), await world.agents.thirdPartyToken("actions")]) {
    expect(await world.agents.callUnlistedTool(world.agents.withToken(bearer), "get_pack", { name: secret.systemName })).toMatchObject({ reason: "signed-out" });
  }
  const github = (await world.recorder.invocations({ raw: true })).slice(before).filter((i) => /github/.test(i.target));
  expect(github).toEqual([]);
}, oauth);

scenario("IT-MCP-011 Authenticated search includes only the caller's private packs", async (world) => {
  const annAccount = world.access.account("ann");
  const ann = await world.users.create({ handle: "ann", githubId: annAccount.id });
  await ann.signIn();
  const a = await world.packs.public("@acme/alpha", { visibility: "private" });
  const b = await world.packs.public("@acme/bravo", { visibility: "private" });
  const c = await world.packs.public("@open/charlie");
  await world.access.allowAccount(a, annAccount);
  for (const pack of [a, b, c]) await world.search.list(pack, { pitch: "Zephyr deployment tooling", category: "cloud" });

  const agent = await world.agents.oauth(ann);
  const ids = async (who: McpAgent) => (await who.search("zephyr deployment")).body.cards.map((card: { id: string }) => card.id).sort();
  expect(await ids(agent)).toEqual([a.name, c.name].sort());
  expect((await agent.mine()).body.packs.map((p: { id: string }) => p.id)).toEqual([a.name]);
  expect(await ids(world.agents.anonymous())).toEqual([c.name]);
  const blocked = await agent.pack(b);
  expect(blocked.ok).toBe(false);
  expect(blocked.body.error).toBe("not_found");
}, oauth);

scenario("IT-MCP-012 Access tokens are short-lived and a revoked grant stops at the next refresh", async (world) => {
  const ann = await reader(world, "ann");
  const client = await world.agents.authServer.register();
  if (client instanceof Refusal) throw new Error("registration refused");
  const session = await ann.signIn();
  const consent = await client.authorize(ann, { session });
  if (consent instanceof Refusal) throw new Error("no consent page");
  const granted = await consent.approve();
  if (granted instanceof Refusal) throw new Error("not granted");
  const tokens = await granted.exchange();
  if (tokens instanceof Refusal) throw new Error("no token");
  expect(tokens.expiresInS).toBe(3600);
  const accepted = (t: { accessToken: string }) => world.agents.holding(t).credentialAccepted();

  await world.clock.advance("59m");
  expect(await accepted(tokens)).toBe(true);
  await world.clock.advance("2m");
  expect(await accepted(tokens)).toBe(false);
  const fresh = await tokens.refresh();
  if (fresh instanceof Refusal) throw new Error("the refresh was refused");
  expect(await accepted(fresh)).toBe(true);

  const [grant] = await world.agents.authServer.grants(ann, session);
  await world.agents.authServer.revoke(ann, session, grant!.id);
  expect(await fresh.refresh()).toBeInstanceOf(Refusal);
  expect(await accepted(fresh)).toBe(false);
}, oauth);


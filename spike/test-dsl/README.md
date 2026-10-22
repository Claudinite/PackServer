# Spike: integration-test DSL on Cloudflare Workers

A runnable proof of the tooling claims behind PackServer's planned integration suite:
two Workers (`web`, `mcp`) sharing a D1 database, R2 for archives, a service binding
between them, every outside dependency faked, and scenarios written in the domain
language only. Findings and timings are in [RESULTS.md](RESULTS.md).

```
workers/web        sign-in via an external OIDC issuer (JWKS fetch), publish (D1 row + R2 archive +
                   validation-LLM call), view/download, site search proxied to mcp over a service binding
workers/mcp        agent search over the shared D1 (FTS5); reports its BUILD_ID
migrations/        shared D1 schema (applied by the harness per scenario)
tests/scenarios/   Layer 1: scenarios, domain language only, titles name requirement IDs
tests/world/       Layer 2: the World (users, packs, agents, validation, recorder) + matchers
tests/drivers/     Layer 3: Driver interface, shared HTTP protocol, inprocess (harness+MSW) and http drivers
tests/fakes/       fakes for the OIDC issuer and the validation LLM, served by MSW or a real port
tests/tooling/     tests of the tooling itself (isolation, unfaked-egress enforcement)
scripts/           check-scenarios.mjs (vocabulary + traceability gate), dev.mjs
requirements.md    spike-sized register in the docs/requirements format
```

## Run

```sh
npm install
npm test                 # check-scenarios + vitest, in-process driver (createTestHarness + MSW)
npm run typecheck
npx vitest run --reporter=verbose   # shows per-scenario timing annotations
```

Other modes:

```sh
ISOLATION=aliases npm test        # no storage reset between scenarios; unique names only (faster)
npm run test:compat               # builds mcp twice (--define BUILD_ID), runs web from source + mcp from the "previous" bundle
```

HTTP driver (same scenarios, system in another process):

```sh
npm run dev                       # terminal 1: mcp on :8788 then web on :8787, shared local state, vars pointed at the fakes
npm run test:http                 # terminal 2: TEST_DRIVER=http; starts the fakes on :9797, talks only HTTP
```

If `wrangler dev` reports `Address already in use (socket "direct:1:default")`, a workerd from an
earlier run is still alive: `pkill -x workerd` and start again.

## What a scenario looks like

```ts
scenario("REQ-PRIV-001 a private pack looks nonexistent to other members and to agents", async (world) => {
  const alice = await world.users.create();
  await alice.signIn();
  const pack = await alice.publish(world.packs.sample({ visibility: "private" }));

  const bob = await world.users.create();
  await bob.signIn();
  await expect(bob.view(pack)).resolves.toBeNotFound();

  const agent = world.agents.anonymous();
  expect(await agent.search(pack.name)).not.toContain(pack);
});
```

`scripts/check-scenarios.mjs` (runs as `pretest`) fails the build if a scenario file contains a
URL, `fetch(`, an HTTP verb, a status code, SQL, a binding, `try/catch`, `.skip/.only`, real time,
or an import from anywhere but the World; if a title names no requirement or an unknown one; or if
an `active` requirement has no scenario.

import { viewCacheControl } from "@packserver/core/catalog";
import { Hono, type Context } from "hono";
import { cdnOriginOf, type WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { readContents } from "../../routes/packs/contents";
import { Adopt, ContentsView, Facts, Glance, Head, Manifest, ReadmeView, Tabs, TrustDrawer, VersionsView, type Tab } from "./components";
import { loadHistory, loadPack, type PackData, type PackLoad } from "./data";
import { PACK_CSS } from "./styles";

const page = new Hono<WebEnv>();

const NO_STORE = "private, no-store";

function Shell(props: { data: PackData; tab: Tab; nonce: string; children?: unknown }) {
  return (
    <>
      <style nonce={props.nonce} dangerouslySetInnerHTML={{ __html: PACK_CSS }} />
      <Head data={props.data} />
      <Tabs name={props.data.name} current={props.tab} />
      {props.children as never}
    </>
  );
}

function failure(c: Context<WebEnv>, status: 410 | 503, title: string, message: string, retry: string) {
  c.header("cache-control", NO_STORE);
  c.status(status);
  return renderPage(c, {
    title,
    children: (
      <>
        <h1>{title}</h1>
        <p class="pk-note">{message} {status === 503 ? <a href={retry}>Try again</a> : <a href="/browse">Browse packs</a>}</p>
      </>
    ),
  });
}

/** The pack a request names, or the response that ends it. */
async function resolve(c: Context<WebEnv>, version?: string): Promise<{ data: PackData } | { response: Response | Promise<Response> }> {
  const result: PackLoad = await loadPack(c, c.req.param("scope") ?? "", c.req.param("name") ?? "", version);
  const here = new URL(c.req.url).pathname;
  switch (result.kind) {
    case "ok":
      return { data: result.data };
    case "not_found":
      return { response: c.notFound() };
    case "removed":
      return { response: failure(c, 410, "This pack has been removed", "It is no longer available.", here) };
    case "unavailable":
      return { response: failure(c, 503, "This pack is unavailable", "Its details could not be loaded right now.", here) };
  }
}

function cacheable(c: Context<WebEnv>) {
  c.header("cache-control", viewCacheControl({ cookie: c.req.header("cookie") ?? null, authorization: c.req.header("authorization") ?? null }));
}

page.get("/packs/:scope/:name", async (c) => {
  const asked = c.req.query("version");
  const got = await resolve(c, asked);
  if ("response" in got) return got.response;
  const { data } = got;
  const version = data.version;
  const read = version ? await readContents(c, data.name, version.version) : undefined;
  cacheable(c);
  return renderPage(c, {
    title: `${data.name} · Claudinite Packs`,
    children: (
      <Shell data={data} tab="overview" nonce={c.get("cspNonce")}>
        {version ? <Glance data={data} version={version} /> : null}
        {version ? <Manifest version={version} /> : null}
        <Adopt data={data} version={version} />
        {version ? <Facts data={data} version={version} /> : null}
        {version ? <ReadmeView markdown={read?.kind === "found" ? read.contents.readme : undefined} /> : null}
        <TrustDrawer data={data} version={version} />
      </Shell>
    ),
  });
});

page.get("/packs/:scope/:name/contents", async (c) => {
  const got = await resolve(c, c.req.query("version"));
  if ("response" in got) return got.response;
  const { data } = got;
  if (!data.version) return c.redirect(`/packs/${data.name}`);
  const read = await readContents(c, data.name, data.version.version);
  if (read.kind === "unavailable") return failure(c, 503, "Contents are unavailable", "The files of this version could not be loaded right now.", new URL(c.req.url).pathname);
  cacheable(c);
  return renderPage(c, {
    title: `Contents of ${data.name} · Claudinite Packs`,
    children: (
      <Shell data={data} tab="contents" nonce={c.get("cspNonce")}>
        <ContentsView contents={read.contents} />
      </Shell>
    ),
  });
});

page.get("/packs/:scope/:name/versions", async (c) => {
  const got = await resolve(c);
  if ("response" in got) return got.response;
  const { data } = got;
  const history = await loadHistory(c, data.name);
  if (!history) return failure(c, 503, "Versions are unavailable", "The signed history of this pack could not be loaded right now.", new URL(c.req.url).pathname);
  cacheable(c);
  return renderPage(c, {
    title: `Versions of ${data.name} · Claudinite Packs`,
    children: (
      <Shell data={data} tab="versions" nonce={c.get("cspNonce")}>
        <VersionsView data={data} history={history} origin={cdnOriginOf(c)} />
      </Shell>
    ),
  });
});

export const routes = new Hono().route("/", page);

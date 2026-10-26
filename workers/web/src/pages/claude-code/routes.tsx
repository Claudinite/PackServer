import { Hono } from "hono";
import { siteOriginOf, type WebEnv } from "../../context";
import { renderPage } from "../../layout";

export const routes = new Hono<WebEnv>();

const TOOLS = [
  { name: "search_packs", does: "Find packs by task or keyword, with filters.", signIn: false },
  { name: "list_categories", does: "The fixed categories, with counts.", signIn: false },
  { name: "get_pack", does: "One pack's card, manifest line and contents.", signIn: false },
  { name: "get_download", does: "Where to fetch a version and its checksum.", signIn: false },
  { name: "list_my_packs", does: "Your packs, private ones included.", signIn: true },
  { name: "star_pack", does: "Star a pack for you.", signIn: true },
] as const;

routes.get("/claude-code", (c) => {
  const endpoint = `${siteOriginOf(c)}/mcp`;
  const config = JSON.stringify({ mcpServers: { "claudinite-packs": { type: "http", url: endpoint } } }, null, 2);
  return renderPage(c, {
    title: "Claude Code · Claudinite Packs",
    current: "/claude-code",
    children: (
      <>
        <h1>Claude Code</h1>
        <p class="lede">A session can search, read and fetch packs here, then propose <code>cn adopt</code> to you.</p>
        <section class="section">
          <h2>Endpoint</h2>
          <pre class="snippet">{endpoint}</pre>
          <pre class="snippet">claude mcp add --transport http claudinite-packs {endpoint}</pre>
          <pre class="snippet">{config}</pre>
        </section>
        <section class="section">
          <h2>Tools</h2>
          <ul class="tools">
            {TOOLS.map((t) => (
              <li><code>{t.name}</code> <span class="muted">{t.does}{t.signIn ? " Needs sign-in." : ""}</span></li>
            ))}
          </ul>
        </section>
        <section class="section">
          <h2>Private packs</h2>
          <ul class="tools">
            <li>In a session, sign in over OAuth with your passkey or GitHub when the client asks.</li>
            <li>With a <code>psr_</code> read token from your account security page.</li>
            <li>In CI, with the GitHub Actions OIDC token.</li>
          </ul>
        </section>
        <section class="section">
          <h2>Rate limits</h2>
          <p class="mt2">About 60 requests a minute per address without sign-in, about 600 a minute with a token.</p>
        </section>
      </>
    ),
  });
});

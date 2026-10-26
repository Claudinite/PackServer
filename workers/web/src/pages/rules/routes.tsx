import { RULES_VERSIONS, loadRules } from "@packserver/rules";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";
import { titleCase } from "../browse/format";

export const routes = new Hono<WebEnv>();

const CLASSES = [
  ["fail", "Fail: the version is refused"],
  ["hold", "Hold: a person decides"],
  ["warn", "Warn: published, with a note"],
] as const;

routes.get("/rules", (c) => {
  const version = RULES_VERSIONS[RULES_VERSIONS.length - 1]!;
  const rules = loadRules(version);
  const needle = (c.req.query("q") ?? "").trim().toLowerCase();
  const matches = (r: { id: string; description: string }) => !needle || `${r.id} ${r.description}`.toLowerCase().includes(needle);
  return renderPage(c, {
    title: "Rules · Claudinite Packs",
    current: "/rules",
    children: (
      <>
        <h1>Rules</h1>
        <p class="lede">Rules version <code>{version}</code></p>
        <form class="search" method="get" action="/rules">
          <input type="search" name="q" value={c.req.query("q") ?? ""} placeholder="Search rules" aria-label="Search rules" />
          <button class="btn" type="submit">Search</button>
        </form>
        {CLASSES.map(([cls, label]) => {
          const rows = rules.staticRules.rules.filter((r) => r.class === cls && matches(r));
          return rows.length === 0 ? null : (
            <section class="section">
              <h2>{label}</h2>
              <table class="rules">
                <tbody>
                  {rows.map((r) => (
                    <tr id={r.id}>
                      <td><code>{r.id}</code></td>
                      <td>{r.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
        <section class="section">
          <h2>Score</h2>
          <table class="rules">
            <tbody>
              {Object.entries(rules.score.parts).map(([part, max]) => (
                <tr><td>{titleCase(part)}</td><td class="cls">up to {max}</td></tr>
              ))}
              <tr><td>Published advisory</td><td class="cls">capped at {rules.score.caps.published_advisory}</td></tr>
              <tr><td>{rules.score.markers.no_public_repo}</td><td class="cls">capped at {rules.score.caps.no_public_repo}</td></tr>
            </tbody>
          </table>
        </section>
        <section class="section">
          <h2>Versions</h2>
          <p class="mt2">{[...RULES_VERSIONS].reverse().map((v, i) => <span>{i > 0 ? ", " : ""}<code>{v}</code></span>)}</p>
        </section>
      </>
    ),
  });
});

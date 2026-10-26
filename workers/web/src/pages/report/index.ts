import { Hono } from "hono";
import { findPublicPack } from "@packserver/core/reports";
import type { WebEnv } from "../../context";
import { runtimeOf } from "../../context";
import { renderReportPage } from "./form";

const page = new Hono<WebEnv>();

/** Pack › Report: a bug or a private security report (flow 4). Reporting needs a signed-in person. */
page.get("/packs/:scope/:name/report", async (c) => {
  const pack = await findPublicPack(runtimeOf(c).ports.d1, c.req.param("scope"), c.req.param("name"));
  if (!pack) return c.notFound();
  return renderReportPage(c, { pack: pack.name, signedIn: c.get("session") !== undefined });
});

export const routes = new Hono().route("/", page);

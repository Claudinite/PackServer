import { PRICES, Price } from "@packserver/ui";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";

export const routes = new Hono<WebEnv>();

const TIERS = [
  { price: PRICES.newPack, buys: "Publishing a pack under your scope. Waived for Verified Publishers." },
  { price: PRICES.verifiedPublisher, buys: "A review that lets your scope carry the Verified Publisher label." },
  { price: PRICES.seat, buys: "Private packs for a team, with an allowlist per pack." },
] as const;

routes.get("/pricing", (c) =>
  renderPage(c, {
    title: "Pricing · Claudinite Packs",
    current: "/pricing",
    children: (
      <>
        <h1>Pricing</h1>
        <p class="lede">These are the goal prices. Nothing is charged yet.</p>
        <ul class="prices">
          {TIERS.map((t) => (
            <li>
              <div class="amount"><Price amount={t.price.amount} unit={t.price.unit} /></div>
              <div class="what">{t.buys}</div>
            </li>
          ))}
        </ul>
        <a class="btn" href="/dashboard">Apply for Verified Publisher</a>
      </>
    ),
  }),
);

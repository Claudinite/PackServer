import { PRICES, Price } from "@packserver/ui";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { renderPage } from "../../layout";

export const routes = new Hono<WebEnv>();

const TIERS = [
  { name: "New pack", price: PRICES.newPack, buys: "Publishing a pack under your scope." },
  { name: "Verified Publisher", price: PRICES.verifiedPublisher, buys: "A review that lets your scope carry the Verified Publisher label." },
  { name: "Team", price: PRICES.seat, buys: "Private packs for a team, with an allowlist per pack." },
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
              <h2>{t.name}</h2>
              <div class="amount"><Price amount={t.price.amount} unit={t.price.unit} /></div>
              <div class="what">{t.buys}</div>
            </li>
          ))}
        </ul>
        <p class="what">Apply for Verified Publisher in your organisation's settings, under Verification.</p>
      </>
    ),
  }),
);

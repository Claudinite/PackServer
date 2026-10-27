import { InfrastructureError } from "../errors";
import type { User } from "../types";

/** The dashboard as its owner reads it: the rows the page lists and its words, never its markup. */
export interface DashboardView {
  /** The page's visible words. */
  text: string;
  /** The kind of each Needs-you row, in the order shown. */
  needs: string[];
  /** One entry per pack row, named as the site spells it: compare with a pack handle's `systemName`. */
  packs: Array<{ name: string; text: string }>;
}

export interface DashboardModule {
  dashboard: {
    of(person: User): Promise<DashboardView>;
  };
}

const words = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

export function createDashboard(): DashboardModule {
  return {
    dashboard: {
      async of(person) {
        const res = await person.request("GET", "/dashboard");
        if (res.status !== 200) throw new InfrastructureError(`the dashboard answered ${res.status}`);
        const body = res.text.replace(/<(style|script)[\s\S]*?<\/\1>/g, "");
        return {
          text: words(/<main[\s\S]*<\/main>/.exec(body)?.[0] ?? body),
          needs: [...body.matchAll(/data-need="([^"]+)"/g)].map((m) => m[1] ?? ""),
          packs: [...body.matchAll(/<li data-pack="([^"]+)">([\s\S]*?)<\/li>/g)].map((m) => ({ name: m[1] ?? "", text: words(m[2] ?? "") })),
        };
      },
    },
  };
}

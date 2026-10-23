import { CrystalGlyph, HOVER_DISMISS_SCRIPT, pageCss } from "@packserver/ui";
import type { Context } from "hono";
import type { Child } from "hono/jsx";

export interface NavLink {
  href: string;
  label: string;
}

export const NAV: readonly NavLink[] = [
  { href: "/browse", label: "Browse" },
  { href: "/claude-code", label: "Claude Code" },
  { href: "/rules", label: "Rules" },
  { href: "/pricing", label: "Pricing" },
];

export interface LayoutProps {
  title: string;
  nonce: string;
  current?: string;
  children?: Child;
}

/**
 * The page shell. Its only inline code is the stylesheet and the Escape-dismiss script, both
 * under the response nonce; pack content placed in `children` is escaped text and carries none.
 */
export function Layout(props: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <style nonce={props.nonce} dangerouslySetInnerHTML={{ __html: pageCss() }} />
      </head>
      <body>
        <header class="hdr">
          <div class="in">
            <a class="logo" href="/"><CrystalGlyph /> Claudinite Packs</a>
            <nav class="nav">
              {NAV.map((l) => <a href={l.href} aria-current={props.current === l.href ? "page" : undefined}>{l.label}</a>)}
            </nav>
          </div>
        </header>
        <main class="wrap">{props.children}</main>
        <script nonce={props.nonce} dangerouslySetInnerHTML={{ __html: HOVER_DISMISS_SCRIPT }} />
      </body>
    </html>
  );
}

/** Renders a page with the nonce `securityHeaders()` made for this request. */
export function renderPage(c: Context, props: Omit<LayoutProps, "nonce">) {
  return c.html(<Layout {...props} nonce={c.get("cspNonce")} />);
}

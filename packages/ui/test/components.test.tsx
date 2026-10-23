import { describe, expect, it } from "vitest";
import {
  FileText, ManifestLine, NeedsYouQueue, Price, PRICES, Pulse, PublisherMark, Rating, ScoreRing, Severity, ShapeGlyph, StatusChip,
  Drawer, pageCss, segmentWidths, sparkPath, tokens, tokenCss,
} from "../src";

const html = (node: unknown) => String(node);

describe("PublisherMark (REQ-SCOPE-015, IT-SCOPE-015 component half)", () => {
  const proof = { kind: "domain", label: "acme.com", since: "2026-03-01" } as const;
  it("shows the proof itself, with Verified Publisher only in the hover", () => {
    const out = html(<PublisherMark proof={proof} verifiedPublisher packCount={2} />);
    expect(out).toMatch(/<span class="name">acme\.com<\/span>/);
    expect(out).not.toContain("unproven");
    const visible = out.replace(/<span class="pop[\s\S]*?<\/span>(?=<\/span>$)/, "");
    expect(visible).not.toContain("Verified Publisher");
    expect(out).toContain("Verified Publisher");
    expect(out).toContain("2 public packs");
  });
  it("shows a GitHub proof as github.com/acme", () => {
    expect(html(<PublisherMark proof={{ kind: "github", label: "github.com/acme", since: "2026-04-01" }} />)).toContain(">github.com/acme<");
  });
  it("reads Unproven without a proof", () => {
    const out = html(<PublisherMark />);
    expect(out).toContain("mark pub unproven");
    expect(out).toContain(">Unproven<");
  });
});

describe("Price (REQ-PAY-017, IT-PAY-017 component half)", () => {
  it("strikes the goal price and says free through 2026", () => {
    expect(html(<Price {...PRICES.newPack} />)).toBe(`<span class="price"><s>$1 per new pack</s><span class="free">free through 2026</span></span>`);
    expect(html(<Price {...PRICES.verifiedPublisher} />)).toContain("<s>$99 a year</s>");
    expect(html(<Price {...PRICES.seat} />)).toContain("<s>$7 per seat per month</s>");
  });
  it("styles struck prices with a line-through", () => {
    expect(pageCss()).toMatch(/\.price s \{[^}]*line-through/);
  });
});

describe("components", () => {
  it("ManifestLine lists the counts, marks a widening, and omits zero parts", () => {
    const out = html(<ManifestLine counts={{ guards: 1, tasks: 4, checks: 3, skills: 6, githubActions: true }} newIn="1.61021.1" drawerId="manifest" />);
    expect(out).toContain("Adds 1 guard · 4 scheduled tasks · 3 checks · 6 skills · GitHub actions");
    expect(out).toContain(" · new in 1.61021.1");
    expect(out).toContain(`href="#manifest"`);
    expect(html(<ManifestLine counts={{ guards: 0, tasks: 0, checks: 1, skills: 0, githubActions: false }} />)).toContain("Adds 1 check");
  });
  it("ScoreRing shows the number and the single largest improvement", () => {
    const out = html(<ScoreRing score={86} improvement="+6 trim the rules" parts={[{ name: "Context cost", score: 20, max: 25 }]} />);
    expect(out).toContain("<b>86</b>");
    expect(out).toContain("+6 trim the rules");
    expect(out).toContain("Context cost · 20/25");
  });
  it("ShapeGlyph widths are proportional and fit 48px", () => {
    const w = segmentWidths([1, 3]);
    expect(w[1]! / w[0]!).toBeCloseTo(3, 5);
    expect(w[0]! + w[1]! + 1).toBeCloseTo(48, 5);
    expect(html(<ShapeGlyph counts={{ rules: 1, skills: 2, checks: 0, guards: 0, tasks: 0 }} />)).toContain("1 rule, 2 skills");
  });
  it("Rating shows a dash under five ratings", () => {
    expect(html(<Rating mean={5} count={4} />)).toContain("—");
    expect(html(<Rating mean={4.6} count={212} />)).toContain("<b>4.6</b>");
  });
  it("Pulse says No fetches yet for an empty series and draws a path otherwise", () => {
    expect(html(<Pulse series={[0, 0]} />)).toContain("No fetches yet");
    expect(sparkPath([0, 5, 10])).toMatch(/^M0\.0 13\.0 L32\.0 7\.0 L64\.0 1\.0$/);
    expect(html(<Pulse series={[1, 2, 3]} fetchedBy="about 9.3k networks" />)).toContain("fetched by about 9.3k networks");
  });
  it("StatusChip distinguishes live, working, needs-you, draft and private", () => {
    expect(html(<StatusChip status="live" />)).not.toContain("svg");
    expect(html(<StatusChip status="working" />)).toContain("spin");
    expect(html(<StatusChip status="needs-you" />)).toContain(`class="dot"`);
    expect(html(<StatusChip status="live" draft />)).toContain("Draft");
    expect(html(<StatusChip status="live" visibility="private" />)).toContain("Private");
  });
  it("NeedsYouQueue lists rows with one action each, or says nothing needs you", () => {
    expect(html(<NeedsYouQueue rows={[]} />)).toContain("Nothing needs you");
    const out = html(<NeedsYouQueue rows={[{ what: "1.61020.1 awaiting approval", action: { label: "Approve", href: "/a" } }]} />);
    expect(out).toContain("Needs you · 1");
    expect(out).toContain(`<a href="/a">Approve</a>`);
  });
  it("Severity is filled for high, outline for medium, absent for low", () => {
    expect(html(<Severity level="high" />)).toContain(`fill="var(--fail)"`);
    expect(html(<Severity level="medium" />)).toContain(`fill="none"`);
    expect(html(<Severity level="low" />)).toBe("");
    expect(html(<Severity level={null} />)).toBe("");
  });
  it("Drawer is addressed by id and closes with a plain link", () => {
    const out = html(<Drawer id="trust" title="Trust"><p>x</p></Drawer>);
    expect(out).toContain(`id="trust"`);
    expect(out).toContain(`href="#"`);
  });
  it("FileText escapes HTML and SVG", () => {
    const out = html(<FileText path="a.svg" text={`<svg onload="x()"><script>1</script></svg>`} />);
    expect(out).not.toContain("<svg");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;svg onload=");
  });
});

describe("tokens", () => {
  it("defines the named palette and a dark counterpart for every token", () => {
    expect(tokens.light.paper).toBe("#faf8f4");
    expect(tokens.light.ink).toBe("#16180f");
    expect(tokens.light.malachite).toBe("#0e7c52");
    expect(Object.keys(tokens.dark)).toEqual(Object.keys(tokens.light));
    expect(tokenCss()).toContain("--malachite: #0e7c52;");
    expect(tokenCss()).toContain("--grey-1:");
  });
  it("keeps every spacing in the stylesheet on the 8-pt grid", () => {
    const css = pageCss().replace(/\b(?:max-width|width|height|min-width|font-size|stroke-width)\s*:[^;]*;/g, "");
    for (const m of css.matchAll(/\b(?:padding|margin|gap)(?:-[a-z]+)?\s*:\s*([^;}]+)/g)) {
      for (const px of (m[1] ?? "").matchAll(/(\d+)px/g)) {
        const n = Number(px[1]);
        // 16px page gutters, 2/4/6px hairline offsets and 12px inner padding are the declared exceptions
        expect([0, 2, 4, 6, 12, 16].includes(n) || n % 8 === 0, m[0]).toBe(true);
      }
    }
  });
  it("uses no inline style attribute or external host in markup", () => {
    expect(html(<ShapeGlyph counts={{ rules: 1, skills: 1, checks: 1, guards: 1, tasks: 1 }} />)).not.toContain("style=");
    expect(html(<Rating mean={4} count={9} distribution={[0, 1, 2, 3, 3]} />)).not.toContain("style=");
    expect(pageCss()).not.toMatch(/https?:\/\//);
  });
});

import { grid, layout, tokenCss, typeScale } from "./tokens";

const g = (n: number) => `${n * grid}px`;

/** Fonts are system stacks: the strict CSP allows no third-party font host. */
const sans = `"Source Sans 3", "IBM Plex Sans", system-ui, "Segoe UI", sans-serif`;
const mono = `"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace`;

const base = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: ${sans}; font-size: ${typeScale.body}px; line-height: 1.5; font-variant-numeric: tabular-nums; overflow-x: hidden; }
h1, h2, h3 { margin: 0; font-weight: 500; line-height: 1.25; text-wrap: balance; }
h1 { font-size: ${typeScale.display}px; letter-spacing: -0.01em; }
h2 { font-size: ${typeScale.lead}px; }
h3 { font-size: ${typeScale.body}px; }
p { margin: 0; }
a { color: var(--malachite); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: ${mono}; }
code { font-size: ${typeScale.small}px; }
pre { margin: 0; font-size: ${typeScale.small}px; line-height: 1.5; overflow-x: auto; max-width: 100%; }
:focus-visible { outline: 2px solid var(--malachite); outline-offset: 2px; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.muted { color: var(--grey-2); }
.small { font-size: ${typeScale.small}px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.row { display: flex; flex-wrap: wrap; gap: ${g(1)} ${g(2)}; align-items: center; min-width: 0; }
.stack { display: flex; flex-direction: column; gap: ${g(1)}; min-width: 0; }
.hair { border: 0; border-top: 1px solid var(--line); margin: ${g(4)} 0; }
`;

const shell = `
.hdr { position: sticky; top: 0; z-index: 20; background: var(--paper); padding: ${g(2)} 16px; }
.hdr .in { max-width: ${layout.column}px; margin: 0 auto; display: flex; align-items: center; gap: ${g(3)}; min-width: 0; }
.logo { display: inline-flex; align-items: center; gap: ${g(1)}; font-weight: 600; font-size: ${typeScale.lead}px; color: var(--ink); letter-spacing: -0.01em; }
.logo:hover { text-decoration: none; }
.logo svg { width: 20px; height: 20px; }
.nav { display: flex; gap: ${g(2)}; margin-left: auto; }
.nav a { color: var(--grey-2); }
.nav a[aria-current="page"] { color: var(--ink); }
.wrap { max-width: ${layout.column}px; margin: 0 auto; padding: ${g(4)} 16px ${g(12)}; }
.readme { max-width: ${layout.readme}px; }
.readme p, .readme ul, .readme ol, .readme pre, .readme blockquote { margin-bottom: ${g(2)}; }
.readme blockquote { border-left: 2px solid var(--line-strong); padding-left: ${g(2)}; color: var(--grey-1); }
.readme code { background: var(--grey-5); padding: 0 4px; border-radius: 3px; }
.readme pre code { background: none; padding: 0; }
.readme pre { background: var(--grey-5); padding: ${g(1)} ${g(2)}; border-radius: 6px; }
`;

const marks = `
.mark { display: inline-flex; align-items: center; gap: 6px; line-height: 1; color: var(--ink); }
.mark svg { width: 16px; height: 16px; flex: none; }
.pub .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ink); flex: none; }
.pub.unproven .dot { background: none; border: 1.5px solid var(--grey-2); }
.pub.unproven { color: var(--grey-2); }
.pub .name { font-family: ${mono}; font-size: ${typeScale.small}px; }
.manifest { font-size: ${typeScale.small}px; color: var(--grey-1); max-width: 620px; }
.manifest a { color: inherit; }
.manifest a:hover { color: var(--ink); text-decoration: none; }
.manifest .lead { color: var(--ink); font-weight: 500; }
.manifest .flag { color: var(--warn); font-weight: 500; }
.ring { display: inline-flex; align-items: center; gap: ${g(1)}; }
.ring svg { width: 32px; height: 32px; transform: rotate(-90deg); }
.ring .track { stroke: var(--grey-4); }
.ring .arc { stroke: var(--ink); }
.ring .arc.ok { stroke: var(--ok); }
.ring .arc.warn { stroke: var(--warn); }
.ring .arc.fail { stroke: var(--fail); }
.ring b { font-weight: 500; }
.ring .improve { color: var(--grey-2); font-size: ${typeScale.small}px; }
.shape { width: 48px; height: 8px; display: block; fill: var(--grey-1); }
.shape .dim { opacity: .55; }
.rating b { font-weight: 500; }
.rating .n { color: var(--grey-2); }
.spark { width: 64px; height: 14px; display: block; color: var(--ink); }
.pulse { display: inline-flex; align-items: center; gap: ${g(1)}; font-size: ${typeScale.small}px; color: var(--grey-1); }
.sev svg { width: 14px; height: 14px; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: ${typeScale.small}px; color: var(--ink); }
.chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); }
.chip svg.lock { width: 12px; height: 12px; color: var(--grey-2); }
.chip.draft { color: var(--grey-2); }
.chip .spin { width: 14px; height: 14px; animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.plain { color: inherit; }
.needs h2 { margin-bottom: ${g(1)}; }
.needs ul { list-style: none; margin: 0; padding: 0; }
.needs li { display: flex; gap: ${g(2)}; align-items: baseline; padding: ${g(1)} 0; }
.needs li .what { flex: 1 1 auto; min-width: 0; }
.needs li .why { color: var(--grey-2); font-size: ${typeScale.small}px; }
.price s { text-decoration: line-through; color: var(--grey-1); }
.price .free { color: var(--ink); margin-left: 6px; }
`;

const layers = `
.hc { position: relative; display: inline-flex; align-items: center; }
.hc > .trigger { display: inline-flex; align-items: center; gap: 6px; border-radius: 4px; color: inherit; cursor: default; }
.pop { position: absolute; top: calc(100% + 8px); left: 0; z-index: 40; min-width: 180px; width: max-content; max-width: min(300px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 8px 24px var(--shadow); padding: ${g(1)} 12px; font-size: ${typeScale.small}px; color: var(--ink); opacity: 0; visibility: hidden; transform: translateY(-2px); transition: opacity 120ms, transform 120ms, visibility 120ms; pointer-events: none; }
.hc:hover .pop, .hc:focus-within .pop { opacity: 1; visibility: visible; transform: none; pointer-events: auto; }
html.esc .hc:hover .pop, html.esc .hc:focus-within .pop { opacity: 0; visibility: hidden; }
.pop.right { left: auto; right: 0; }
.pop ul { list-style: none; margin: 0; padding: 0; }
.pop li + li { margin-top: 2px; }
.pop .hint { color: var(--grey-2); font-size: 12px; margin-top: 6px; }
.dist { display: grid; grid-template-columns: 10px 100px 32px; gap: 4px 8px; align-items: center; }
.dist svg { display: block; width: 100px; height: 6px; }
.dist .back { fill: var(--grey-4); }
.dist .fill { fill: var(--grey-1); }
.drawer { position: fixed; inset: 0 0 0 auto; width: min(480px, 100vw); z-index: 50; background: var(--surface); border-left: 1px solid var(--line); box-shadow: -8px 0 24px var(--shadow); padding: ${g(3)}; overflow-y: auto; transform: translateX(100%); visibility: hidden; transition: transform 200ms, visibility 200ms; }
.drawer:target { transform: none; visibility: visible; }
.drawer .close { position: absolute; top: ${g(2)}; right: ${g(2)}; color: var(--grey-2); }
.drawer h2 { margin-bottom: ${g(2)}; padding-right: ${g(4)}; }
@media (prefers-reduced-motion: reduce) { .drawer, .pop { transition: none; } .chip .spin { animation: none; } }
`;

/** The one stylesheet every page inlines under a nonce. */
export function pageCss(): string {
  return [tokenCss(), base, shell, marks, layers].join("\n");
}

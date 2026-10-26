import { grid, typeScale } from "@packserver/ui";

const g = (n: number) => `${n * grid}px`;

/** Rules for the pack page only; the shared stylesheet stays with the shell. */
export const PACK_CSS = `
.status-line { border-left: 3px solid var(--warn); padding: ${g(1)} ${g(2)}; margin-bottom: ${g(3)}; }
.status-line.fail { border-left-color: var(--fail); }
.status-line a { margin-left: ${g(1)}; }
.pk-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: ${g(1)} ${g(2)}; }
.pk-head h1 { font-size: ${typeScale.display}px; overflow-wrap: anywhere; }
.pk-head svg.lock { width: 14px; height: 14px; color: var(--grey-2); align-self: center; }
.pk-pitch { color: var(--grey-1); font-size: ${typeScale.lead}px; margin-top: ${g(1)}; overflow-wrap: anywhere; }
.pk-glance { display: flex; flex-wrap: wrap; gap: ${g(1)} ${g(3)}; align-items: center; margin-top: ${g(2)}; font-size: ${typeScale.small}px; }
.tabs { display: flex; gap: ${g(3)}; margin: ${g(3)} 0; border-bottom: 1px solid var(--line); }
.tabs a { color: var(--grey-2); padding: ${g(1)} 0; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }
.adopt { margin: ${g(2)} 0 ${g(3)}; }
.adopt pre { background: var(--grey-5); border-radius: 6px; padding: ${g(1)} ${g(2)}; user-select: all; }
.adopt pre + pre { margin-top: ${g(1)}; }
.adopt .preview { color: var(--grey-1); }
.facts { margin: ${g(2)} 0 ${g(3)}; font-size: ${typeScale.small}px; }
.facts summary { cursor: pointer; color: var(--grey-2); }
.facts dl { display: grid; grid-template-columns: max-content 1fr; gap: ${g(1)} ${g(3)}; margin: ${g(1)} 0 0; }
.facts dt { color: var(--grey-2); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.hash { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.drawer h3 { margin-top: ${g(3)}; color: var(--grey-2); font-weight: 500; font-size: ${typeScale.small}px; }
.drawer ul { margin: ${g(1)} 0 0; padding-left: ${g(2)}; }
.vers { width: 100%; border-collapse: collapse; font-size: ${typeScale.small}px; }
.vers th { text-align: left; font-weight: 500; color: var(--grey-2); padding: 0 ${g(2)} ${g(1)} 0; }
.vers td { padding: ${g(1)} ${g(2)} ${g(1)} 0; vertical-align: top; border-top: 1px solid var(--line); }
.vers .wide { color: var(--warn); }
.vers .held { color: var(--fail); }
.vers-scroll { overflow-x: auto; }
.part { margin-top: ${g(4)}; }
.part h2 { font-size: ${typeScale.body}px; color: var(--grey-2); font-weight: 500; text-transform: capitalize; }
.file { margin-top: ${g(2)}; }
.file h3 { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: ${typeScale.small}px; font-weight: 500; }
.sec { border-top: 1px solid var(--line); padding: ${g(1)} 0; }
.sec pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.pk-note { margin-top: ${g(6)}; color: var(--grey-1); }
`;

import { grid } from "@packserver/ui";

const g = (n: number) => `${n * grid}px`;

/** Rules for the settings pages beyond what the account pages already style. */
export const SETTINGS_CSS = `
.acct .jump { display: flex; flex-wrap: wrap; gap: ${g(1)} ${g(3)}; margin-top: ${g(2)}; }
.acct .record { margin-top: ${g(1)}; }
.acct .record code { overflow-wrap: anywhere; }
.acct .form select, .acct .form textarea { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; padding: ${g(1)} 12px; min-width: 0; }
.acct .form textarea { font-family: var(--mono, monospace); }
.acct .snippet { white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; }
.acct .tag { color: var(--grey-2); font-size: 0.875em; }
`;

export const REGISTRATION_CSS = `
.acct .facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin-top: 4px; }
.acct .facts dt { color: var(--grey-2); }
.acct .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.acct .facts code + code { margin-left: 8px; }
.acct .packrow { margin-top: 24px; }
.acct fieldset.events { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; }
.acct fieldset.events legend { padding: 0; margin-bottom: 4px; }
.acct .form .row { flex-direction: row; align-items: center; }
`;

import { grid, typeScale } from "@packserver/ui";

const g = (n: number) => `${n * grid}px`;

/** Rules for the sign-in and account pages; the shared stylesheet stays with the shell. */
export const ACCOUNT_CSS = `
[hidden] { display: none !important; }
.btn.primary { background: var(--malachite); color: var(--on-malachite); border-color: var(--malachite); }
.btn.primary:hover { filter: brightness(1.08); }
.btn.quiet { border-color: transparent; padding-left: 0; padding-right: 0; }
.btn.quiet:hover { border-color: transparent; text-decoration: underline; }
.btn[disabled] { filter: none; }
.btn.danger { color: var(--fail); }
.signin { max-width: 420px; }
.signin form { display: contents; }
.form { display: flex; flex-direction: column; gap: ${g(2)}; max-width: 420px; margin-top: ${g(3)}; }
.form label { display: flex; flex-direction: column; gap: 4px; }
.form input[type="text"], .form input[type="email"], .form input[type="number"], .dlg input[type="text"] { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; padding: ${g(1)} 12px; min-width: 0; }
.form .hint { color: var(--grey-2); font-size: ${typeScale.small}px; }
.err { color: var(--fail); margin-top: ${g(1)}; }
.dlg { border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--ink); padding: ${g(3)}; width: min(480px, calc(100vw - 32px)); }
.dlg::backdrop { background: rgba(22, 24, 15, 0.4); }
.dlg .snippet { white-space: pre-wrap; user-select: all; }
.acct section { margin-top: ${g(6)}; }
.acct .alert { display: flex; gap: ${g(1)}; align-items: baseline; margin-top: ${g(3)}; flex-wrap: wrap; }
.acct .alert .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); flex: none; align-self: center; }
.acct .list { list-style: none; margin: ${g(1)} 0 0; padding: 0; }
.acct .list li { display: flex; flex-wrap: wrap; gap: ${g(1)} ${g(2)}; align-items: baseline; padding: ${g(1)} 0; }
.acct .list li + li { border-top: 1px solid var(--line); }
.acct .list .grow { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.acct .list .when { color: var(--grey-2); font-size: ${typeScale.small}px; }
.acct details > summary { cursor: pointer; }
.acct details.fold > summary { color: var(--ink); }
.acct details.fold > .body { margin-top: ${g(1)}; }
.acct .status { color: var(--grey-1); margin-top: ${g(2)}; min-height: 1.5em; }
`;

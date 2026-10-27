import { grid, typeScale } from "@packserver/ui";

const g = (n: number) => `${n * grid}px`;

export const WIZARD_CSS = `
.wiz .steps { display: flex; flex-wrap: wrap; gap: ${g(1)} ${g(3)}; list-style: none; margin: ${g(2)} 0 0; padding: 0; color: var(--grey-2); font-size: ${typeScale.small}px; }
.wiz .steps li[aria-current="step"] { color: var(--ink); font-weight: 500; }
.wiz section { margin-top: ${g(3)}; }
.wiz .form { max-width: 480px; margin-top: ${g(2)}; }
.wiz .form select, .wiz .form input[type="file"] { font: inherit; color: var(--ink); }
.wiz .form select { background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; padding: ${g(1)} 12px; }
.wiz .at { color: var(--grey-1); }
.wiz fieldset.choice { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: ${g(1)}; }
.wiz label.inline { flex-direction: row; align-items: baseline; gap: ${g(1)}; }
.wiz .row { margin-top: ${g(2)}; }
.wiz .facts { display: grid; grid-template-columns: max-content 1fr; gap: ${g(1)} ${g(3)}; margin: ${g(2)} 0; }
.wiz .facts dt { color: var(--grey-2); }
.wiz .facts dd { margin: 0; overflow-wrap: anywhere; }
.wiz .log { margin-top: ${g(1)}; }
.wiz .finding { padding: ${g(1)} 0; }
.wiz .finding + .finding { border-top: 1px solid var(--line); }
.wiz details.fold { margin-top: ${g(2)}; }
`;

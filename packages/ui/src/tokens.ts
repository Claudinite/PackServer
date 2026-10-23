/** Design tokens (docs/ui/design-principles.md §Visual language). Light is the default; dark redefines the same names. */
export const tokens = {
  light: {
    paper: "#faf8f4",
    surface: "#ffffff",
    ink: "#16180f",
    grey1: "#4a4a42",
    grey2: "#75756b",
    grey3: "#a3a39a",
    grey4: "#e4e1d9",
    grey5: "#f0ede6",
    line: "rgba(22, 24, 15, 0.08)",
    lineStrong: "rgba(22, 24, 15, 0.2)",
    malachite: "#0e7c52",
    onMalachite: "#ffffff",
    ok: "#2e7d4f",
    warn: "#b7791f",
    fail: "#b3261e",
    shadow: "rgba(22, 24, 15, 0.12)",
  },
  dark: {
    paper: "#131410",
    surface: "#1b1c18",
    ink: "#ebe8e0",
    grey1: "#bcb9af",
    grey2: "#8f8d84",
    grey3: "#5f5e57",
    grey4: "#2c2d27",
    grey5: "#22231e",
    line: "rgba(235, 232, 224, 0.08)",
    lineStrong: "rgba(235, 232, 224, 0.22)",
    malachite: "#4fc592",
    onMalachite: "#131410",
    ok: "#5fb37e",
    warn: "#d6a24e",
    fail: "#e27c74",
    shadow: "rgba(0, 0, 0, 0.5)",
  },
} as const;

export type TokenName = keyof typeof tokens.light;

/** Type scale in px; weight, not size, carries the rest of the hierarchy. */
export const typeScale = { small: 13, body: 14, lead: 16, title: 20, display: 28 } as const;

/** The 8-pt grid: every spacing in the stylesheet is a multiple of this unit. */
export const grid = 8;

export const layout = { column: 760, readme: 680 } as const;

const kebab = (name: string) => name.replace(/[A-Z]|\d+/g, (m) => `-${m.toLowerCase()}`);
const declarations = (set: Record<string, string>) => Object.entries(set).map(([k, v]) => `--${kebab(k)}: ${v};`).join(" ");

export function tokenCss(): string {
  return [
    `:root { ${declarations(tokens.light)} }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${declarations(tokens.dark)} color-scheme: dark; } }`,
    `:root[data-theme="dark"] { ${declarations(tokens.dark)} color-scheme: dark; }`,
  ].join("\n");
}

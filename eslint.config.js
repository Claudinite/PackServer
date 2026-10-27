import js from "@eslint/js";
import tseslint from "typescript-eslint";
import scenarios from "./eslint/scenarios.js";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", ".claudinite/**", ".turbo/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { files: ["**/*.{js,mjs}"], languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", URL: "readonly", Buffer: "readonly", structuredClone: "readonly", URLSearchParams: "readonly", Response: "readonly", setTimeout: "readonly", clearTimeout: "readonly" } } },
  ...scenarios,
);

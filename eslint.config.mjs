import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**", ".wrangler/**", "cloudflare-env.d.ts"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["src/client/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/anchor-is-valid": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
  },
  {
    files: ["scripts/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
]);

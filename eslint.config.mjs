import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // ReviewBot scripts are CommonJS copied as-is. Package lint does not restyle them.
  { ignores: ["dist/", "build/", "node_modules/", ".github/codex/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.{mjs,cjs}"],
    languageOptions: { globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);

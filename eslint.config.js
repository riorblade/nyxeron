import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist", "**/node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/{web,admin}/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Repo tooling runs in Node (CommonJS for actions/github-script).
    files: [".github/scripts/**/*.{cjs,mjs}", "scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);

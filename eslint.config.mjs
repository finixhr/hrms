import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [
  { ignores: ["upload/**", "node_modules/**", "tests/**"] },
  ...nextCoreWebVitals, ...nextTypescript, {
  // files: without this key the object applies to EVERY linted file (.json,
  // .md, …) while the react/@typescript-eslint plugin registrations above are
  // scoped to code files — ESLint 9 then refuses to load the config with
  // "could not find plugin react" (re-audit 2026-10-18: the gate could not
  // run at all in a fresh clone). Same extension set eslint-config-next uses.
  files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
  rules: {
    // M-18 / audit #20 — gates RESTORED as failing CI stages:
    "prefer-const": "error",
    "no-redeclare": "error",
    "no-unreachable": "error",
    "no-debugger": "error",
    "no-fallthrough": "error",
    "no-case-declarations": "error",
    "@typescript-eslint/prefer-as-const": "error",
    "react/no-unescaped-entities": "error",

    // no-unused-vars: ERROR (audit #20) — unused imports/locals were removed
    // across the codebase; leading-underscore names are exempt by convention.
    "@typescript-eslint/no-unused-vars": ["error", {
      "args": "all", "argsIgnorePattern": "^_",
      "caughtErrors": "all", "caughtErrorsIgnorePattern": "^_",
      "varsIgnorePattern": "^_", "destructuredArrayIgnorePattern": "^_",
    }],
    // no-non-null-assertion: ERROR (audit #20) — every existing occurrence now
    // carries a documented `-- audited TODO(H-20 paydown)` suppression; new
    // code must pass an explicit null check or justify itself the same way.
    // L-32 paydown (2026-10-02): the worst file (routes/procurement.ts, 10
    // suppressions) is assertion-free; remaining suppressions are tracked
    // per-file — cdatapic (6), seed (4), cdata (4), attendance-devices (2),
    // processor (2), reports (2), ait-engine (2), +1-line strays.
    "@typescript-eslint/no-non-null-assertion": "error",

    // Deliberately still relaxed (documented deviations from audit #20):
    //  - no-explicit-any: the typed-any paydown is a tracked refactor — the
    //    audit measured ~40 latent anys per file; blocking on them now would
    //    freeze every merge without adding runtime safety. tsc's noImplicitAny
    //    still guards inference. Revisit after the typed-API milestone.
    //  - no-console: the codebase uses structured console.error logging at
    //    the edges (audit's own guidance says keep, redirect later).
    "@typescript-eslint/no-explicit-any": "off",
    "no-console": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "react-hooks/exhaustive-deps": "off",
    "react-compiler/react-compiler": "off",
    // Re-audit 2026-10-18 — two rules that shipped NEW with
    // eslint-config-next 16's react-hooks v6 set flag 19 pre-existing sites
    // in shipped views (setState-in-effect data loaders; TipTap extensions
    // created in the rich-text editor's render body). Refactoring those
    // data-loading effects and the editor's extension table without UI test
    // coverage risks breaking live screens for zero behavioral gain, so the
    // rules are tracked deviations like exhaustive-deps above — the paydown
    // belongs to the (test-harness-gated) frontend refactor round.
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/static-components": "off",
    "@next/next/no-img-element": "off",
    "no-empty": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills"]
}];

export default eslintConfig;

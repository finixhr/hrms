// ============ Mobile ESLint flat config (M5 fix for the M3-known crash) ============
// Root cause of the old `npx eslint .` crash ("Cannot read properties of
// undefined (reading 'allowShortCircuit')"): the mobile app had NO ESLint
// config of its own, so ESLint 8.57 (flat-capable) searched ancestors and
// loaded the WORKSPACE ROOT web-app eslint.config.mjs — whose
// typescript-eslint v8 rule set was instantiated by the mobile-local 8.57
// linter and crashed on rule-option shape. eslint-config-expo@8 is
// eslintrc-style only, so it is bridged through FlatCompat here, resolving
// plugins from THIS directory's node_modules (the mobile tree).
import { FlatCompat } from "@eslint/eslintrc"
import { fileURLToPath } from "url"
import { dirname } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const compat = new FlatCompat({ baseDirectory: __dirname })

export default [
  {
    ignores: [
      "node_modules/**", ".expo/**", "android/**", "ios/**",
      "dist/**", "web-build/**", "expo-env.d.ts",
    ],
  },
  ...compat.extends("expo"),
]

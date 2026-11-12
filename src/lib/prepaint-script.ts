// ============ Pre-paint theme + design script — SINGLE SOURCE OF TRUTH ============
// The exact script served as the STATIC FILE public/prepaint.js and loaded
// synchronously from <head> by src/app/layout.tsx (runs before first paint,
// applies the stored theme class so dark-mode users never see a flash).
//
// SEC-9 (2026-11-09, P2 wave) — delivery switched from an inline
// dangerouslySetInnerHTML blob to the static self-hosted file: the script is
// now covered by script-src 'self' and no longer depends on the CSP's
// 'unsafe-inline' escape hatch (which the Turbopack-standalone build still
// needs for the framework's own RSC flight-payload chunks — see
// src/proxy.ts for that history). A unit test pins public/prepaint.js to
// THIS constant byte-for-byte.
//
// ⚠ If you edit this string, regenerate the file:
//     bun -e 'import { PREPAINT_SCRIPT } from "./src/lib/prepaint-script"; \
//             require("node:fs").writeFileSync("public/prepaint.js", PREPAINT_SCRIPT + "\n")'
//   — the pinning unit test fails until the file matches (no silent drift).
//
// 2026-10-25 — Platform Design Systems (master prompt Part L §17): the script
// also applies data-design on <html> BEFORE first paint. Preference keys are
// per-surface, mirroring the theme keys: localStorage `hrm_design` on /app,
// `owner_design` on /owner (values "comet" | "cursor-1" | "cursor-2"; invalid
// or missing values fall back to "comet", the platform default). Public pages
// carry NO design attribute — it is removed so a client-side navigation into
// the marketing group never inherits a workspace design (src/saas/web/theme.tsx
// re-strips it post-navigation as well). React never renders data-design, so
// there is no hydration mismatch: only this script and src/hrm/design.tsx
// (applyDesign) ever touch the attribute.
export const PREPAINT_SCRIPT = `try{var p=location.pathname,r=document.documentElement;var dk=p==="/app"||p.indexOf("/app/")===0?"hrm_design":(p==="/owner"||p.indexOf("/owner/")===0?"owner_design":null);if(dk){var dv=null;try{dv=localStorage.getItem(dk)}catch(e){}r.setAttribute("data-design",dv==="cursor-1"||dv==="cursor-2"?dv:"comet")}else{r.removeAttribute("data-design")}if(p==="/app"||p.indexOf("/app/")===0){if(localStorage.getItem("hrm_theme")==="dark"){r.classList.add("dark")}}else if(p==="/owner"||p.indexOf("/owner/")===0){if(localStorage.getItem("owner_theme")!=="light"){r.classList.add("dark")}}else{var t=null;try{t=localStorage.getItem("site_theme")}catch(e){}var d=t==="dark"||(t!=="light"&&!!window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d){r.classList.add("dark")}}}catch(e){}`

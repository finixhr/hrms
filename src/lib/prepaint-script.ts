// ============ Pre-paint theme + design script — SINGLE SOURCE OF TRUTH ============
// The exact string injected by src/app/layout.tsx into <head> (runs before
// first paint, applies the stored theme class so dark-mode users never see a
// flash). Exported so the CSP middleware can hash it and allow it via
// 'sha256-…' in script-src — the nonce-based CSP with 'strict-dynamic' blocks
// nonce-less inline scripts, which silently disabled this script until the
// React theme-sync effect re-applied the class post-hydration (visible flash).
//
// ⚠ If you edit this string, the CSP hash updates automatically (middleware
//   hashes THIS constant at module load) — no manual step needed. (The live
//   policy currently ships script-src 'self' 'unsafe-inline' — see
//   src/proxy.ts — so the inline script is allowed as-is either way.)
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

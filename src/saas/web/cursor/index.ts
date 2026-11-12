// ============ Cursor system public surface ==================================
// Mount once from the public site layout:
//   <SiteCursor config={cursorConfig} />
// Data-attribute API for everything else — see custom-cursor.tsx header.
// NOTE: the cursor system is scoped to the PUBLIC website only — the owner
// console and tenant HRM app never import this module.
export { SiteCursor } from "./custom-cursor"
export { Magnetic } from "./magnetic"
export type { CursorConfig, CursorStyle } from "../content-types"

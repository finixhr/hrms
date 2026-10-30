// ============ Global Search — pure query normalization + relevance ranking ============
// Shared by the search.global route (server) and covered by unit tests without
// any database dependency (the repo's unit-test convention: pure functions only).

/** Trim, collapse inner whitespace and hard-cap the raw query. Returns "" when
 *  the query is too short to search with (fewer than MIN_QUERY chars). */
export const MIN_QUERY = 2
export const MAX_QUERY = 64

export function normalizeQuery(raw: unknown): string {
  const q = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY)
  return q
}

/** Relevance score for one candidate text against the normalized query.
 *  Higher is better; 0 means "does not match".
 *  Order: exact > starts-with > word-boundary > partial. Case-insensitive. */
export function scoreText(q: string, text: string | null | undefined): number {
  if (!q) return 0
  const qq = q.toLowerCase()
  const t = String(text ?? "").toLowerCase()
  if (!t) return 0
  if (t === qq) return 100
  if (t.startsWith(qq)) return 80
  const idx = t.indexOf(qq)
  if (idx === -1) return 0
  // word-boundary match (previous char is a space, punctuation start or a separator)
  if (idx === 0 || /[\s\-_/&,.)]/.test(t[idx - 1])) return 65
  return 50
}

/** Best score across the fields an entity is searchable by.
 *  `boost` only applies to a field that actually MATCHES — a boosted field with
 *  no match must stay 0, otherwise every row would match every query. */
export function bestScore(q: string, fields: { text: string | null | undefined; boost?: number }[]): number {
  let best = 0
  for (const f of fields) {
    const base = scoreText(q, f.text)
    if (base === 0) continue
    const s = base + (f.boost ?? 0)
    if (s > best) best = s
  }
  return best
}

/** Rank a list of candidates by relevance and cap the result count.
 *  Deterministic tie-break: score desc, then the primary text asc. */
export function rankByRelevance<T>(
  q: string,
  items: T[],
  fields: (item: T) => { text: string | null | undefined; boost?: number }[],
  primaryText: (item: T) => string,
  limit: number,
): T[] {
  const scored = items
    .map((item) => ({ item, score: bestScore(q, fields(item)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || primaryText(a.item).localeCompare(primaryText(b.item)))
  return scored.slice(0, limit).map((s) => s.item)
}

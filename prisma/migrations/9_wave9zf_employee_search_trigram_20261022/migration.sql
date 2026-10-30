-- MOD-17 (Phase 2 WS4) — trigram index for the employee directory search.
--
-- employees.list's directory search (and employees.refList's picker search)
-- run ILIKE '%q%' over fullName + code (plus mobile/emails in list mode).
-- B-tree indexes cannot serve a leading-wildcard predicate, so every
-- keystroke was a sequential scan of the tenant's employee rows. pg_trgm
-- GIN indexes turn those into index scans; the query text is unchanged
-- (Prisma `mode: "insensitive"` `contains` maps to ILIKE, which the
-- planner serves with these indexes automatically).
--
-- Extension creation is idempotent and standard on managed PostgreSQL
-- (RDS / Supabase / Neon all ship pg_trgm in contrib).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Employee_fullName_trgm_idx" ON "Employee" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX "Employee_code_trgm_idx" ON "Employee" USING gin ("code" gin_trgm_ops);

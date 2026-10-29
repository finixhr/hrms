-- Phase R5 / SEC-02 — session tokens hashed at rest (both planes).
-- Session and SaaSOwnerSession previously used the cookie token AS the primary
-- key, so a read-only database compromise yielded every live session (API keys
-- and refresh tokens were already hashed — sessions were the outlier).
-- Additive rotation, zero downtime:
--   1. add a nullable tokenHash column (sha256 of the cookie token) + unique
--      index (Postgres treats NULLs as distinct, so pre-backfill dups are fine);
--   2. backfill tokenHash = sha256(id) — for legacy rows the id IS the cookie
--      token, so every existing session immediately resolves through the hash
--      path (no dual-read window needed). Their id column stays the legacy
--      plaintext until those rows expire — the documented rotation window;
--   3. new rows (post-migration code) carry id = random row id + the hash; the
--      id stops being a credential entirely for them.
ALTER TABLE "Session" ADD COLUMN "tokenHash" TEXT;
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
UPDATE "Session" SET "tokenHash" = encode(sha256("id"::bytea), 'hex') WHERE "tokenHash" IS NULL;

ALTER TABLE "SaaSOwnerSession" ADD COLUMN "tokenHash" TEXT;
CREATE UNIQUE INDEX "SaaSOwnerSession_tokenHash_key" ON "SaaSOwnerSession"("tokenHash");
UPDATE "SaaSOwnerSession" SET "tokenHash" = encode(sha256("id"::bytea), 'hex') WHERE "tokenHash" IS NULL;

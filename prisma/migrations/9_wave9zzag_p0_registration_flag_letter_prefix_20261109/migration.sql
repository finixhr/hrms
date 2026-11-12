-- P0 REMEDIATION WAVE (2026-11-09 audit) — SEC-3 + SEC-4 schema changes.
-- Additive DDL only + idempotent backfill. Matches prisma/schema.prisma exactly.
--
-- SEC-3 — SaaSRegistration.duplicateEmail: a dedicated NON-PUBLIC column for the
-- "admin email already belongs to an active platform user" flag. The register
-- handler previously wrote a DUPLICATE_EMAIL marker into reviewNote, which the
-- public registrationStatus tracker returned verbatim — an account-existence
-- oracle plus a free-form reviewer-notes leak. reviewNote itself becomes
-- internal-only (the public projection stops returning it); the flag moves here.
--
-- SEC-4 — HrLetter.verificationCodePrefix (+ index): the first 8 hex characters
-- of the verification code (dash-stripped, uppercase). The public
-- /api/verify/letter endpoint has no vendor id, so the (vendorId, verificationCode)
-- index could never serve it — the old route scanned up to 5,000 ISSUED letters
-- and silently 404'd genuine codes past the cap. The prefix column turns the
-- lookup into an index probe; the timing-safe compare stays for the full code.
-- Backfill computes the prefix from the stored code (letters minted before
-- this migration keep verifying unchanged).

-- ============ 1. ALTER SaaSRegistration (SEC-3) ============
ALTER TABLE "SaaSRegistration" ADD COLUMN "duplicateEmail" BOOLEAN NOT NULL DEFAULT false;

-- ============ 2. ALTER HrLetter (SEC-4) ============
ALTER TABLE "HrLetter" ADD COLUMN "verificationCodePrefix" TEXT;
CREATE INDEX "HrLetter_verificationCodePrefix_idx" ON "HrLetter"("verificationCodePrefix");

-- ============ 3. Backfill the prefix for already-issued codes (SEC-4) ============
-- Mirrors letterCodePrefix() in src/hrm-server/routes/letters.ts:
-- strip dashes, uppercase, take the first 8 characters of the 12-hex code.
UPDATE "HrLetter"
SET "verificationCodePrefix" = substr(upper(replace("verificationCode", '-', '')), 1, 8)
WHERE "verificationCode" IS NOT NULL
  AND "verificationCodePrefix" IS NULL;

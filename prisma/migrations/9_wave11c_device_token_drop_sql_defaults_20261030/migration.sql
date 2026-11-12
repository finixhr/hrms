-- Migration 11 (2026-10-30): close the schema-drift found by scripts/check-schema-drift.ts
-- Migration 10 created DeviceToken with SQL-level defaults (gen_random_uuid() /
-- CURRENT_TIMESTAMP), but schema.prisma declares Prisma-level defaults only
-- (@default(cuid()) / @updatedAt): the client always supplies both values, so the
-- SQL defaults are dead weight AND made every `prisma migrate deploy` database
-- disagree with the schema the unit-test database uses (db push shape).
-- This migration aligns the migration chain with schema.prisma EXACTLY.
-- Additive-only policy: no data is touched; existing rows keep their values.

ALTER TABLE "DeviceToken" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

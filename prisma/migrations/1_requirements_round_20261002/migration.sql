-- 20261002_requirements_round — schema changes for the 10-requirements round
--
-- R10 (remove QR attendance): the QrToken table (rotating check-in tokens) is
-- dropped. Attendance "source" values of historical rows are untouched — the
-- column is a free-form string and old "QR"-source rows keep rendering.
--
-- R8 (historical backfill): per-device widened ingest window fields.
--   historySyncUntil       — while in the future, old punches are accepted
--   historySyncWindowDays  — how far back the widened window reaches

-- DropTable (R10 — QR attendance removed)
DROP TABLE IF EXISTS "QrToken";

-- AlterTable (R8 — AttendanceDevice history sync)
ALTER TABLE "AttendanceDevice" ADD COLUMN "historySyncUntil" TIMESTAMP(3);
ALTER TABLE "AttendanceDevice" ADD COLUMN "historySyncWindowDays" INTEGER;

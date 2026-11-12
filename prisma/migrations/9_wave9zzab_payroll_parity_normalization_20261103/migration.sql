-- B-7 parity normalization (Option 1(b)) — converge the database onto the
-- schema.prisma expectations for the three representable drift classes that
-- remain after 9_wave9zza:
--   A. PayrollRun company-level unique index name: 9_wave9zy creates it under a
--      76-char name that PostgreSQL server-truncates to ..._runType_ (63),
--      while the datamodel expects Prisma's own 63-char truncation ..._runT_key.
--      Same columns, same UNIQUE semantics — only the stored name differs.
--   B. WorkforceSnapshot.updatedAt: the datamodel declares @default(now()); the
--      historical DDL (9_wave9zv) created the column without a default.
--   C. ApprovalRequest companyId index: declared in the datamodel as
--      @@index([companyId]) (Stage B). 9_wave9zy already created
--      ApprovalRequest_companyId_idx on the migration path; the guarded CREATE
--      covers db-push-baselined databases that never received it.
-- The six Employee GIN/trigram indexes are deliberately NOT normalized here:
-- pg_trgm GIN indexes have no Prisma datamodel representation and remain the
-- single documented parity exemption (scripts/check-schema-parity.mjs).
DO $$
DECLARE
  server_truncated text := 'PayrollRun_companyId_periodYear_periodMonth_periodWeek_runType_';
  prisma_expected   text := 'PayrollRun_companyId_periodYear_periodMonth_periodWeek_runT_key';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'PayrollRun' AND indexname = server_truncated) THEN
    IF EXISTS (SELECT 1 FROM pg_indexes
               WHERE schemaname = 'public' AND tablename = 'PayrollRun' AND indexname = prisma_expected) THEN
      EXECUTE format('DROP INDEX public.%I', server_truncated);
      RAISE WARNING 'B-7 parity: both PayrollRun company-index name variants existed; kept the Prisma-expected % and dropped %', prisma_expected, server_truncated;
    ELSE
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', server_truncated, prisma_expected);
    END IF;
  END IF;
END
$$;

ALTER TABLE "WorkforceSnapshot" ALTER COLUMN "updatedAt" SET DEFAULT now();

CREATE INDEX IF NOT EXISTS "ApprovalRequest_companyId_idx" ON "ApprovalRequest"("companyId");

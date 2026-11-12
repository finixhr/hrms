-- B-7 corrective: normalize the PayrollRun vendor-period unique index name so
-- 9_wave9zy's DROP INDEX succeeds on fresh installs. 0_init created the index
-- as the Prisma-pre-truncated 63-char name (..._runTy_key); 9_wave9zy drops it
-- by the full 75-char name, which PostgreSQL server-truncates to (..._runType_a).
DO $$
DECLARE
  truncated_name text := 'PayrollRun_vendorId_periodYear_periodMonth_periodWeek_runTy_key';
  full_name      text := 'PayrollRun_vendorId_periodYear_periodMonth_periodWeek_runType_adjustSeq_key';
  target_name    text := left(full_name, 63);
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes
             WHERE schemaname = 'public' AND tablename = 'PayrollRun' AND indexname = truncated_name) THEN
    IF EXISTS (SELECT 1 FROM pg_indexes
               WHERE schemaname = 'public' AND tablename = 'PayrollRun' AND indexname = target_name) THEN
      EXECUTE format('DROP INDEX public.%I', truncated_name);
      RAISE WARNING 'B-7 guard: both PayrollRun vendor-index name variants existed; dropped the truncated-name variant %', truncated_name;
    ELSE
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', truncated_name, full_name);
    END IF;
  END IF;
END
$$;

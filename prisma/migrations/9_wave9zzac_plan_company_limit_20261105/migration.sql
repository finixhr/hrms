-- Plan-level limit on how many ACTIVE companies a tenant may run.
-- NULL = unlimited, the same convention as every other plan limit, so nothing is
-- restricted until a number is entered in Owner Console -> Plans.
-- Sorts between 9_wave9zzab and the reserved M4 name 9_wave9zzb, so M4 stays a
-- pure in-order append.
ALTER TABLE "SaaSPlan" ADD COLUMN "companyLimit" INTEGER;

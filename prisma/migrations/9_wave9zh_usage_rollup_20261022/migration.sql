-- MOD-5 / SCL-6 prerequisite (Phase 2 WS6) — per-vendor storage rollup table.
--
-- The storage-quota check (requireCapacity STORAGE) and the owner console's
-- per-vendor usage snapshots ran four SUM(LENGTH(...)) scans over the
-- tenant's inline payload columns on every call. The rollup row is now the
-- read path (one indexed read); write paths bump it best-effort and the
-- platform daily job reconciles it nightly with one set-based statement.

CREATE TABLE "UsageRollup" (
    "vendorId" TEXT NOT NULL,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageRollup_pkey" PRIMARY KEY ("vendorId")
);

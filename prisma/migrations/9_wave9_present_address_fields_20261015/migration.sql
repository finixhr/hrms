-- Add Division, District, City / Upazila, Post Code to Present Address on Employee
ALTER TABLE "Employee"
  ADD COLUMN "presentCity" TEXT,
  ADD COLUMN "presentDistrict" TEXT,
  ADD COLUMN "presentDivision" TEXT,
  ADD COLUMN "presentPostCode" TEXT;

-- Backfill existing records that have addressSame = true
UPDATE "Employee"
SET
  "presentDivision" = "division",
  "presentDistrict" = "district",
  "presentCity" = "city",
  "presentPostCode" = "postCode"
WHERE "addressSame" = true;

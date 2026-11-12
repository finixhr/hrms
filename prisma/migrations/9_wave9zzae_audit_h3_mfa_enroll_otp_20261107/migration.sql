-- AUDIT H-3 (2026-11-07) — out-of-band proof for FIRST-login MFA enrollment.
-- A one-time 6-digit code, emailed to the account address, now gates
-- auth.mfa.enroll.enable whenever the tenant email gateway is configured:
-- whoever holds ONLY the (temporary) password can no longer bind their own
-- TOTP authenticator on an MFA-required role and take over the account
-- ("whoever enrolls first wins"). Both columns are nullable — no OTP is
-- stored while the gateway is unconfigured (enrollment must stay possible,
-- never a lockout) or after the code is consumed/expires, and existing
-- enrolled rows simply keep NULL.
ALTER TABLE "UserMfaSecret" ADD COLUMN "enrollOtpHash" TEXT;
ALTER TABLE "UserMfaSecret" ADD COLUMN "enrollOtpExpiresAt" TIMESTAMP(3);

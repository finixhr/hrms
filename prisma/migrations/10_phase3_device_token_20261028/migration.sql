-- Migration: Phase 3 — Mobile/Desktop DeviceToken registry
-- Stores push notification tokens for Expo/FCM/APNs per user device.

CREATE TABLE "DeviceToken" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid(),
    "vendorId"    TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "platform"    TEXT NOT NULL DEFAULT 'expo',
    "token"       TEXT NOT NULL,
    "deviceName"  TEXT,
    "appVersion"  TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceToken_userId_token_key" ON "DeviceToken"("userId", "token");
CREATE INDEX "DeviceToken_vendorId_userId_idx" ON "DeviceToken"("vendorId", "userId");
CREATE INDEX "DeviceToken_token_idx" ON "DeviceToken"("token");

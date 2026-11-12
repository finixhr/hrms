#!/usr/bin/env bash
# W1 session environment — disposable PostgreSQL 16.4 (zonky portable binaries
# at scripts/pg/, data at scripts/pgdata-test/, port 55432). Source this file
# before any W1 verification procedure. Nothing here touches any non-disposable
# system: the server is session-local, trust-auth, and all databases are scratch.
export W1_PG_HOST=127.0.0.1
export W1_PG_PORT=55432
export W1_PG_SUPERUSER=postgres
export W1_PG_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/pg/bin" && pwd)"
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/hrm_test"
export TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/hrm_test"
export W1_REPLAY_URL="postgresql://postgres:postgres@127.0.0.1:55432/hrm_w1_replay"
export W1_AC07_SCRATCH_URL="postgresql://postgres:postgres@127.0.0.1:55432/hrm_w1_ac07_scratch"
export NODE_ENV=test
# Boot-critical env values for register()/R-26 smoke (validated at boot).
export HRM_MFA_KEY="a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
export HRM_INTERNAL_TOKEN="w1-disposable-internal-token-3f9c2a"
export HRM_BACKUP_KEY="w1-disposable-backup-key-7d1e4b"

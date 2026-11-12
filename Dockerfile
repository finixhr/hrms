# ============ Production image (Wave 4 A2, 2026-10-08) ============
# Multi-stage build on the official Bun image:
#   deps    — install (frozen lockfile), prisma generate, next build
#   runtime — standalone Next server + prisma CLI for boot-time migrations
#
# The container is STATELESS: the entrypoint runs `prisma migrate deploy`
# (additive-only chain, safe to run concurrently on boot) and then starts
# the standalone server. PostgreSQL is expected via DATABASE_URL — use
# docker-compose.yml for the one-command local stack.
#
# Build:  docker build -t finix-hr .
# Run:    docker run -p 4000:4000 -e DATABASE_URL=… finix-hr

# ---------- stage 1: deps + build ----------
FROM oven/bun:1 AS build
WORKDIR /app

# Layer-cache-friendly: install before copying sources
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
RUN bunx prisma generate

COPY . .
# Build-time env: no telemetry, no background jobs (they start at runtime)
ENV NEXT_TELEMETRY_DISABLED=1 \
    HRM_JOBS_ENABLED=false \
    ZKTECO_ADMS_ENABLED=false
RUN bun run build

# ---------- stage 2: runtime ----------
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000 \
    HOSTNAME=0.0.0.0

# OPS-1 (2026-11-09 P1 wave) — the runtime must not be root. The container
# previously ran the entrypoint AND the server as root: any RCE in the app was
# root-level inside the container. The systemd deployment already runs as the
# dedicated `hrm` account (deploy/hrm.service, M-31) — the image now matches.
# Fixed uid/gid 10001 so operators can chown mounted volumes predictably.
# HOME is set (and owned) because the prisma CLI / bun keep small caches under
# $HOME; --create-home also gives the boot-time `prisma migrate deploy` a
# writable scratch location without ever touching /app itself.
RUN groupadd --gid 10001 hrm \
 && useradd --uid 10001 --gid 10001 --system --create-home --home-dir /home/hrm --shell /usr/sbin/nologin hrm
ENV HOME=/home/hrm

# Standalone server bundle (the repo's build script already folds static
# assets + public into .next/standalone). Everything the app may WRITE at
# runtime is owned by hrm (see the mkdir below); the rest is read-only.
COPY --from=build --chown=hrm:hrm /app/.next/standalone ./
COPY --from=build --chown=hrm:hrm /app/.next/static ./.next/static

# Prisma CLI + schema + migrations for the boot-time deploy step.
# --no-save keeps package.json untouched; the prisma CLI binary lands in
# node_modules and the standalone server does not need it at request time.
COPY --from=build --chown=hrm:hrm /app/node_modules/prisma ./node_modules/prisma
COPY --from=build --chown=hrm:hrm /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=build --chown=hrm:hrm /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=hrm:hrm /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=hrm:hrm /app/prisma ./prisma

# R-30 (W1) — the release manifest + the validator ship INSIDE the image:
# the V12 boot assertion (entrypoint) validates the bundled manifest against
# the bundled migrations BEFORE `prisma migrate deploy` runs. node is present
# on the oven/bun image (bun runs .mjs natively too — node is the fallback).
COPY --from=build --chown=hrm:hrm /app/deploy ./deploy
COPY --from=build --chown=hrm:hrm /app/scripts/check-release-artifact.mjs ./scripts/check-release-artifact.mjs

COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# OPS-1 (2026-11-09 P1 wave) — the writable runtime dirs, pre-created owned by
# hrm (the app mkdirs them recursively at first use, but /app itself stays
# root-owned so the process cannot create stray directories):
#   storage/punch-photos — device punch-photo offload (/iclock/cdatapic +
#     the ADMS sweeper; src/app/iclock/cdatapic/route.ts)
#   backups/             — the owner-console scheduled backup artifact dir
#     (src/hrm-server/saas/backup.ts resolves "backups" against cwd)
# stdout/stderr stay on the container log driver (docker logs); a FILE log
# only happens when the operator sets HRM_LOG_FILE — point it at a file on a
# mounted volume and pre-create that file owned by 10001:10001 (the app only
# re-opens an EXISTING path — instrumentation.ts SIGUSR2 handler).
# VOLUME OWNERSHIP: if you mount a volume over /app/storage or /app/backups,
# the mountpoint must be owned by (or writable by) uid/gid 10001, e.g.
#   mkdir -p /srv/hrm/storage && chown -R 10001:10001 /srv/hrm/storage
#   docker run -v /srv/hrm/storage:/app/storage …
# (docker-compose.yml documents the same requirement on the app service).
RUN mkdir -p storage/punch-photos backups \
 && chown -R hrm:hrm /app/storage /app/backups

# OPS-1 — everything above (entrypoint, migrations, server) runs as hrm
USER hrm

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]

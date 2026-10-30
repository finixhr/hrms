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

# Standalone server bundle (the repo's build script already folds static
# assets + public into .next/standalone)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# Prisma CLI + schema + migrations for the boot-time deploy step.
# --no-save keeps package.json untouched; the prisma CLI binary lands in
# node_modules and the standalone server does not need it at request time.
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma

COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]

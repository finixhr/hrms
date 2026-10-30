import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// PostgreSQL client. The old SQLite-specific `file:`-URL anchoring (which walked
// up from the CWD to re-anchor relative paths against the project's prisma/
// directory) was removed with the SQLite→PostgreSQL migration: DATABASE_URL is
// now always a `postgresql://` URL resolved entirely by libpq/Prisma — there is
// no filesystem path to anchor and no traced-copy hazard in .next/standalone.
// Deployment note: the standalone server still chdir's into .next/standalone,
// but a connection URL carries no path state, so no compensation is needed.

// M-12 — log level is environment-driven: production logs errors only (query
// logging put PII into logs and doubled disk writes); development defaults to
// errors+warnings and can opt into queries via HRM_PRISMA_LOG=query,warn,error.
const prismaLog = (process.env.HRM_PRISMA_LOG || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLog.length
      ? (prismaLog as Array<'query' | 'info' | 'warn' | 'error'>)
      : process.env.NODE_ENV === 'production'
        ? ['error']
        : ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

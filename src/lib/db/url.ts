/**
 * Postgres connection string. DATABASE_URL first; POSTGRES_URL is what the
 * Supabase / Vercel Postgres integrations inject, so a database added from the
 * Vercel dashboard is picked up without renaming anything.
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

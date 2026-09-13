import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteDb } from './sqlite.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

export interface Migration {
  name: string;
  sql: string;
}

/**
 * `migrations/*.sql` in name order. The same folder is what `wrangler d1
 * migrations apply` uses for Cloudflare D1, so there is one set of files
 * for both databases.
 */
export function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));
}

/** Local SQLite only: apply every migration not yet recorded in schema_migrations. */
export async function migrate(db: SqliteDb, migrations: Migration[] = loadMigrations()): Promise<string[]> {
  db.exec('create table if not exists schema_migrations (name text primary key, applied_at text not null)');
  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const done: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    db.exec(m.sql);
    await db.query('insert into schema_migrations (name, applied_at) values ($1, $2)', [m.name, new Date().toISOString()]);
    done.push(m.name);
  }
  return done;
}

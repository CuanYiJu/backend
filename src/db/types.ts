import type { SqlClient } from '../magic-link.ts';

export interface Statement {
  text: string;
  params?: unknown[];
}

/**
 * The database interface the app and the magic-link stores share. Queries
 * use Postgres-style `$1` placeholders and ISO-8601 timestamps so the same
 * SQL runs on SQLite (local dev), Cloudflare D1 (production) and, with a
 * small adapter, Postgres.
 *
 * There is deliberately no interactive transaction: D1 only offers atomic
 * batches. Every write that must be race-free is a single self-contained
 * statement, and multi-statement writes go through `batch`.
 */
export interface Db extends SqlClient {
  /** Run the statements atomically, in order; returns each statement's rows. */
  batch<Row = Record<string, unknown>>(statements: Statement[]): Promise<{ rows: Row[] }[]>;
}

export type SqlValue = null | number | string;

/** Normalise JS values to what SQLite-family drivers accept. */
export function toSqlValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new TypeError(`db: unsupported parameter type ${typeof v}`);
}

/** `$1` → `?1`, which SQLite and D1 both understand as a numbered parameter. */
export function toNumberedPlaceholders(text: string): string {
  return text.replace(/\$(\d+)/g, '?$1');
}

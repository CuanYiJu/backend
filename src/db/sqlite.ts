import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { toNumberedPlaceholders, toSqlValue, type Db, type Statement } from './types.ts';

/**
 * node:sqlite (bundled with Node >= 22.5) behind the Db interface, for local
 * development and tests. Date params become ISO strings, which sort
 * correctly as text and round-trip through `new Date()`.
 */
export class SqliteDb implements Db {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  }

  async query<Row = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    const rows = this.run<Row>(text, params);
    return { rows, rowCount: rows.length };
  }

  async batch<Row = Record<string, unknown>>(statements: Statement[]): Promise<{ rows: Row[] }[]> {
    this.raw.exec('begin immediate');
    try {
      const results = statements.map((s) => ({ rows: this.run<Row>(s.text, s.params ?? []) }));
      this.raw.exec('commit');
      return results;
    } catch (err) {
      this.raw.exec('rollback');
      throw err;
    }
  }

  private run<Row>(text: string, params: unknown[]): Row[] {
    return this.raw.prepare(toNumberedPlaceholders(text)).all(...params.map(toSqlValue)) as Row[];
  }

  /** Execute a multi-statement script (migrations). */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }
}

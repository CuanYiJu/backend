import { toNumberedPlaceholders, toSqlValue, type Db, type Statement } from './types.ts';

/** The slice of Cloudflare's D1Database binding we use (structural, no types package needed). */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<{ results: T[]; success: boolean }[]>;
}

/**
 * Cloudflare D1 behind the Db interface. D1 is SQLite, so the SQL is the
 * same as in local development; `batch` is D1's atomic multi-statement
 * call, which is why the app never needs BEGIN/COMMIT.
 */
export class D1Db implements Db {
  private readonly d1: D1Like;

  constructor(d1: D1Like) {
    this.d1 = d1;
  }

  async query<Row = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    const { results } = await this.prepare(text, params).all<Row>();
    return { rows: results, rowCount: results.length };
  }

  async batch<Row = Record<string, unknown>>(statements: Statement[]): Promise<{ rows: Row[] }[]> {
    if (statements.length === 0) return [];
    const results = await this.d1.batch<Row>(statements.map((s) => this.prepare(s.text, s.params ?? [])));
    return results.map((r) => ({ rows: r.results }));
  }

  private prepare(text: string, params: unknown[]): D1PreparedStatement {
    return this.d1.prepare(toNumberedPlaceholders(text)).bind(...params.map(toSqlValue));
  }
}

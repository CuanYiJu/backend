import { CaptureMailer } from '../src/magic-link.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { migrate } from '../src/db/migrate.ts';
import { createApp } from '../src/app.ts';

export const ORIGIN = 'http://localhost:5173';
export const ADMIN_EMAIL = 'admin@example.com';

export interface TestApp {
  config: AppConfig;
  db: SqliteDb;
  mailer: CaptureMailer;
  fetch(path: string, init?: RequestInit & { cookie?: string; json?: unknown }): Promise<Response>;
  /** Full login through the magic-link code path; returns the session cookie. */
  login(email: string): Promise<string>;
  /** Login as the admin and create their profile (admins bypass the name list). */
  admin(): Promise<string>;
  /** Login, put `wechatName` on the list as the admin, and claim it with a profile. */
  member(email: string, nickname?: string, wechatName?: string): Promise<string>;
  close(): void;
}

export async function testApp(): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    MAGIC_LINK_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    APP_BASE_URL: ORIGIN,
    EMAIL_FROM: 'test <login@localhost>',
    ADMIN_EMAILS: `${ADMIN_EMAIL}, second-admin@example.com`,
    DATABASE_FILE: ':memory:',
  });
  const db = new SqliteDb(':memory:');
  await migrate(db);
  const mailer = new CaptureMailer();
  const { hono } = createApp(config, db, { mailer });

  const fetch: TestApp['fetch'] = (path, init = {}) => {
    const { cookie, json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has('origin')) headers.set('Origin', ORIGIN);
    if (cookie) headers.set('Cookie', cookie);
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    const requestInit: RequestInit = { ...rest, headers };
    if (json !== undefined) requestInit.body = JSON.stringify(json);
    return Promise.resolve(hono.request(path, requestInit));
  };

  const login = async (email: string): Promise<string> => {
    const sent = await fetch('/auth/magic-link', { method: 'POST', json: { email } });
    if (sent.status !== 202) throw new Error(`magic-link request failed: ${sent.status} ${await sent.text()}`);
    const code = /验证码 (\d{6})/.exec(mailer.last().subject)?.[1];
    if (!code) throw new Error('no code in email subject');
    const res = await fetch('/auth/verify-code', { method: 'POST', json: { email, code } });
    if (res.status !== 200) throw new Error(`verify-code failed: ${res.status} ${await res.text()}`);
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error('no session cookie');
    return setCookie.split(';')[0] as string;
  };

  let adminCookie: string | null = null;
  const admin = async (): Promise<string> => {
    if (adminCookie) return adminCookie;
    adminCookie = await login(ADMIN_EMAIL);
    const res = await fetch('/api/profile', { method: 'PUT', cookie: adminCookie, json: { nickname: '群主', wechatName: '群主本人' } });
    if (res.status !== 201) throw new Error(`admin profile failed: ${res.status} ${await res.text()}`);
    return adminCookie;
  };

  const member = async (email: string, nickname = email.split('@')[0] as string, wechatName = `wx-${nickname}`): Promise<string> => {
    const a = await admin();
    const added = await fetch('/api/admin/invite-names', { method: 'POST', cookie: a, json: { names: wechatName } });
    if (added.status !== 201) throw new Error(`add name failed: ${added.status} ${await added.text()}`);
    const cookie = await login(email);
    const res = await fetch('/api/profile', { method: 'PUT', cookie, json: { nickname, wechatName } });
    if (res.status !== 201) throw new Error(`profile creation failed: ${res.status} ${await res.text()}`);
    return cookie;
  };

  return { config, db, mailer, fetch, login, admin, member, close: () => db.close() };
}

export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Assert the status, then parse the JSON body (reads the body once). */
export async function expectJson<T = Record<string, unknown>>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** An ISO timestamp `hours` from now (default: tomorrow at the same time). */
export function inHours(hours = 24): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export const baseEvent = {
  kind: 'adhoc',
  title: '周六下午卡坦岛',
  games: '卡坦岛、璀璨宝石',
  location: '北约克 某桌游吧',
  startsAt: inHours(),
  durationMin: 180,
  capacity: 3,
  minSize: 2,
} as const;

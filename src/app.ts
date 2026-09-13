import { Hono } from 'hono';
import type { AppConfig } from './config.ts';
import type { Db } from './db/types.ts';
import { createAuth, type Auth, type AuthOptions } from './auth.ts';
import { createApiRoutes } from './routes/api.ts';

export interface App {
  hono: Hono;
  auth: Auth;
}

/**
 * Assemble the HTTP app: login routes from the magic-link package plus our
 * API. Runtime-neutral (no Node imports) so the same code runs under
 * node:http locally and as a Cloudflare Worker; tests drive it with
 * `hono.request()` against an in-memory database.
 */
export function createApp(config: AppConfig, db: Db, options: AuthOptions = {}): App {
  const auth = createAuth(config, db, options);
  const { handlers } = auth;
  const hono = new Hono();

  hono.post('/auth/magic-link', (c) => handlers.requestLink(c.req.raw));
  hono.get('/auth/verify', (c) => handlers.verifyPage(c.req.raw));
  hono.post('/auth/verify', (c) => handlers.verifyLink(c.req.raw));
  hono.post('/auth/verify-code', (c) => handlers.verifyCode(c.req.raw));
  hono.post('/auth/logout', (c) => handlers.logout(c.req.raw));
  hono.get('/auth/me', (c) => handlers.me(c.req.raw));

  hono.get('/healthz', (c) => c.json({ ok: true }));
  hono.route('/api', createApiRoutes({ config, db, auth }));

  return { hono, auth };
}

/** Paths the API owns; everything else is the frontend. */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname === '/healthz';
}

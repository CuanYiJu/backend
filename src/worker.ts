/**
 * Cloudflare Workers entry (see wrangler.toml). The API and login routes run
 * here against D1; every other path is served from the built frontend by
 * the Workers static-assets binding, with SPA fallback to index.html.
 *
 * Configuration comes from [vars] and `wrangler secret` (same names as
 * .env.example). Migrations are applied with `wrangler d1 migrations apply`,
 * not at startup.
 */
import { loadConfig } from './config.ts';
import { D1Db, type D1Like } from './db/d1.ts';
import { createApp, isApiPath, type App } from './app.ts';

interface Env {
  DB: D1Like;
  ASSETS: { fetch(request: Request): Promise<Response> };
  [name: string]: unknown;
}

let cached: { db: D1Like; app: App } | null = null;

function appFor(env: Env): App {
  if (cached && cached.db === env.DB) return cached.app;
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') vars[k] = v;
  const config = loadConfig({ NODE_ENV: 'production', ...vars });
  const app = createApp(config, new D1Db(env.DB));
  cached = { db: env.DB, app };
  return app;
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    // One canonical host: cookies and the login Origin check are bound to APP_BASE_URL.
    const canonical = typeof env.APP_BASE_URL === 'string' ? new URL(env.APP_BASE_URL) : null;
    if (canonical && url.host !== canonical.host) {
      url.protocol = canonical.protocol;
      url.host = canonical.host;
      return Response.redirect(url.toString(), 301);
    }
    const { pathname } = url;
    if (!isApiPath(pathname)) return env.ASSETS.fetch(request);
    return appFor(env).hono.fetch(request, env, ctx as never);
  },
};

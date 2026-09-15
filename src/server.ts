/**
 * Node entry: local development and single-process self-hosting.
 * (Cloudflare Workers use src/worker.ts instead.)
 */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { loadConfig } from './config.ts';
import { SqliteDb } from './db/sqlite.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './app.ts';
import { serveStaticSite } from './static.ts';

const config = loadConfig();
for (const w of config.warnings) console.warn(`[config] ${w}`);

const db = new SqliteDb(config.databaseFile);
const applied = await migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

const { hono } = createApp(config, db);
if (config.staticDir) serveStaticSite(hono, config.staticDir);

// Without a proxy the magic-link rate limiter needs the socket address; it
// reads this header (the same convention its own dev server uses).
const outer = new Hono();
outer.use('*', async (c, next) => {
  if (!config.trustProxy) {
    const addr = getConnInfo(c).remote.address;
    if (addr) c.req.raw.headers.set('x-magic-link-remote-addr', addr);
  }
  await next();
});
outer.route('/', hono);

serve({ fetch: outer.fetch, port: config.port }, (info) => {
  console.log(`开局 backend listening on http://localhost:${info.port}`);
  console.log(`  public origin (APP_BASE_URL): ${config.magicLink.baseUrl}`);
  console.log(`  admins: ${config.adminEmails.join(', ')}`);
  console.log(`  database: ${config.databaseFile}`);
  if (config.e2eMailbox) console.log('  E2E_MAILBOX on: login emails kept in memory, readable at /api/_test/mail?to=...');
  else if (!config.mailjet && !config.resendApiKey) console.log('  login emails are printed here (no MAILJET_* or RESEND_API_KEY set)');
});

const shutdown = () => {
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

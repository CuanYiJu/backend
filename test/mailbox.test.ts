import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { migrate } from '../src/db/migrate.ts';
import { createApp } from '../src/app.ts';
import { MailboxMailer } from '../src/mailers/mailbox.ts';

const base = { NODE_ENV: 'test', MAGIC_LINK_SECRET: 'x'.repeat(40), APP_BASE_URL: 'http://localhost:5173', EMAIL_FROM: 'a <a@b.c>', ADMIN_EMAILS: 'a@b.c' };

test('E2E_MAILBOX exposes the latest login mail per address and is refused in production', async () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', E2E_MAILBOX: '1', MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' }), /production/);

  const db = new SqliteDb(':memory:');
  await migrate(db);
  const { hono, auth } = createApp(loadConfig({ ...base, E2E_MAILBOX: '1' }), db);
  assert.ok(auth.mailbox instanceof MailboxMailer);
  try {
    const send = (email: string) =>
      hono.request('/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base.APP_BASE_URL },
        body: JSON.stringify({ email }),
      });
    assert.equal((await send('one@e2e.test')).status, 202);
    assert.equal((await send('one@e2e.test')).status, 202); // two sends: the newest wins
    assert.equal((await send('two@e2e.test')).status, 202);

    const res = await hono.request('/api/_test/mail?to=ONE@e2e.test');
    assert.equal(res.status, 200);
    const mail = (await res.json()) as { to: string; code: string; link: string; subject: string };
    assert.equal(mail.to, 'one@e2e.test');
    assert.match(mail.code, /^\d{6}$/);
    assert.match(mail.link, /^http:\/\/localhost:5173\/auth\/verify\?token=/);
    assert.ok(mail.subject.includes(mail.code));
    assert.equal(auth.mailbox.size, 3);

    assert.equal((await hono.request('/api/_test/mail?to=nobody@e2e.test')).status, 404);
    assert.equal((await hono.request('/api/_test/mail')).status, 400);

    // Rate limits are off in this mode: many sends from one IP still succeed.
    for (let i = 0; i < 15; i++) assert.equal((await send('many' + i + '@e2e.test')).status, 202);
  } finally {
    db.close();
  }
});

test('without E2E_MAILBOX the test route does not exist', async () => {
  const db = new SqliteDb(':memory:');
  await migrate(db);
  const { hono, auth } = createApp(loadConfig(base), db);
  try {
    assert.equal(auth.mailbox, null);
    assert.equal((await hono.request('/api/_test/mail?to=a@b.c')).status, 404);
  } finally {
    db.close();
  }
});

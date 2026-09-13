import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailjetMailer, parseAddress } from '../src/mailers/mailjet.ts';
import { loadConfig } from '../src/config.ts';
import { LoggingMailer, selectMailer } from '../src/auth.ts';

const message = { to: 'someone@example.com', from: '开局 <login@example.com>', subject: '开局 登录验证码 123456', text: 'text', html: '<p>html</p>' };

test('parseAddress handles display names and bare addresses', () => {
  assert.deepEqual(parseAddress('开局 <login@example.com>'), { name: '开局', email: 'login@example.com' });
  assert.deepEqual(parseAddress('"Kai Ju" <login@example.com>'), { name: 'Kai Ju', email: 'login@example.com' });
  assert.deepEqual(parseAddress('login@example.com'), { name: null, email: 'login@example.com' });
});

test('MailjetMailer posts the Send API v3.1 payload with Basic auth', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ Messages: [{ Status: 'success' }] }), { status: 200 });
  }) as typeof fetch;
  const mailer = new MailjetMailer({ apiKey: 'key', secretKey: 'secret', fetch: fakeFetch });
  await mailer.send(message);

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://api.mailjet.com/v3.1/send');
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as Record<string, string>).Authorization, `Basic ${btoa('key:secret')}`);
  const payload = JSON.parse(call.init.body as string) as { Messages: Record<string, unknown>[] };
  assert.deepEqual(payload.Messages[0], {
    From: { Email: 'login@example.com', Name: '开局' },
    To: [{ Email: 'someone@example.com' }],
    Subject: '开局 登录验证码 123456',
    TextPart: 'text',
    HTMLPart: '<p>html</p>',
  });
});

test('MailjetMailer surfaces HTTP errors and per-message rejections', async () => {
  const http401 = (async () => new Response('{"ErrorMessage":"bad key"}', { status: 401, statusText: 'Unauthorized' })) as typeof fetch;
  await assert.rejects(new MailjetMailer({ apiKey: 'k', secretKey: 's', fetch: http401 }).send(message), /401.*bad key/);

  const rejected = (async () =>
    new Response(JSON.stringify({ Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'sender not validated' }] }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(new MailjetMailer({ apiKey: 'k', secretKey: 's', fetch: rejected }).send(message), /sender not validated/);

  assert.throws(() => new MailjetMailer({ apiKey: '', secretKey: 's' }), /required/);
});

test('config picks Mailjet when both keys are set and refuses half a pair', () => {
  const base = { NODE_ENV: 'test', MAGIC_LINK_SECRET: 'x'.repeat(40), APP_BASE_URL: 'http://localhost:5173', EMAIL_FROM: 'a <a@b.c>', ADMIN_EMAILS: 'a@b.c' };
  const provider = (m: unknown) => (m instanceof LoggingMailer ? m.provider : (m as object).constructor.name);
  assert.equal(provider(selectMailer(loadConfig({ ...base, MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' }))), 'mailjet');
  assert.equal(provider(selectMailer(loadConfig({ ...base, RESEND_API_KEY: 'r' }))), 'resend');
  assert.equal(provider(selectMailer(loadConfig(base))), 'ConsoleMailer');
  assert.throws(() => loadConfig({ ...base, MAILJET_API_KEY: 'k' }), /both/);
});

test('LoggingMailer logs the provider error and rethrows', async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => errors.push(String(msg));
  try {
    const failing = { send: async () => { throw new Error('ResendMailer: 403 Forbidden {"message":"domain not verified"}'); } };
    await assert.rejects(new LoggingMailer('resend', failing).send(message), /403/);
    assert.equal(errors.length, 1);
    assert.match(errors[0] as string, /\[mail:resend\] send to someone@example.com failed: .*domain not verified/);
  } finally {
    console.error = orig;
  }
});

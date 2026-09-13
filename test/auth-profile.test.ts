import { test } from 'node:test';
import assert from 'node:assert/strict';
import { body, expectJson, testApp } from './helpers.ts';
import type { InviteName } from '../src/services/invites.ts';

test('magic-link login works end to end on SQLite and /api/me reports no profile yet', async () => {
  const app = await testApp();
  try {
    assert.equal((await app.fetch('/api/me')).status, 401);

    const cookie = await app.login('Ada@Example.com');
    const me = await body<{ user: { id: string; email: string }; profile: unknown; isAdmin: boolean }>(await app.fetch('/api/me', { cookie }));
    assert.equal(me.user.email, 'ada@example.com');
    assert.equal(me.profile, null);
    assert.equal(me.isAdmin, false);

    // Logged in but without a profile: the app API is closed.
    const err = await body(await app.fetch('/api/events', { cookie }));
    assert.equal(err.error, 'profile_required');

    // Logout clears the session.
    assert.equal((await app.fetch('/auth/logout', { method: 'POST', cookie })).status, 204);
    assert.equal((await app.fetch('/api/me', { cookie })).status, 401);
  } finally {
    app.close();
  }
});

test('profile creation requires a WeChat name from the admin list; admins bypass it', async () => {
  const app = await testApp();
  try {
    // Admin onboarding needs no list entry, and is recorded as claimed.
    const admin = await app.admin();
    const me = await body<{ isAdmin: boolean; profile: { wechatName: string } }>(await app.fetch('/api/me', { cookie: admin }));
    assert.equal(me.isAdmin, true);
    assert.equal(me.profile.wechatName, '群主本人');

    // Admin pastes names: newlines, commas and 、 all separate; duplicates are reported.
    const added = await expectJson<{ added: InviteName[]; duplicates: string[] }>(
      await app.fetch('/api/admin/invite-names', { method: 'POST', cookie: admin, json: { names: '小明 🎲\n阿花, 老王、小明🎲\n\n' } }),
      201,
    );
    assert.deepEqual(added.added.map((n) => n.name), ['小明 🎲', '阿花', '老王']);
    assert.deepEqual(added.duplicates, []);
    const again = await expectJson<{ added: InviteName[]; duplicates: string[] }>(
      await app.fetch('/api/admin/invite-names', { method: 'POST', cookie: admin, json: { names: '阿花' } }),
      201,
    );
    assert.deepEqual(again.duplicates, ['阿花']);

    const cookie = await app.login('bob@example.com');

    // Missing name.
    const missing = await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明' } });
    assert.equal(missing.status, 400);

    // Whitespace, case and full-width forms are forgiven; emoji must match.
    const ok = await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明', wechatName: '小明🎲' } });
    const created = await expectJson<{ profile: { nickname: string; wechatName: string } }>(ok, 201);
    assert.equal(created.profile.nickname, '小明');
    assert.equal(created.profile.wechatName, '小明 🎲'); // stored as the admin typed it

    // The same name cannot be claimed by a second account: it goes to the queue instead.
    const other = await app.login('carol@example.com');
    const taken = await expectJson<{ profile: { status: string } }>(
      await app.fetch('/api/profile', { method: 'PUT', cookie: other, json: { nickname: 'Carol', wechatName: '小明 🎲' } }),
      201,
    );
    assert.equal(taken.profile.status, 'pending');
    // Resubmitting with a listed name activates immediately.
    const resubmit = await expectJson<{ profile: { status: string; wechatName: string } }>(
      await app.fetch('/api/profile', { method: 'PUT', cookie: other, json: { nickname: 'Carol', wechatName: ' 阿 花 ' } }),
      200,
    );
    assert.equal(resubmit.profile.status, 'active');
    assert.equal(resubmit.profile.wechatName, '阿花');

    // The admin list shows who claimed what.
    const list = await expectJson<{ names: InviteName[] }>(await app.fetch('/api/admin/invite-names', { cookie: admin }), 200);
    const byName = Object.fromEntries(list.names.map((n) => [n.name, n.claimedBy?.nickname ?? null]));
    assert.equal(byName['小明 🎲'], '小明');
    assert.equal(byName['阿花'], 'Carol');
    assert.equal(byName['老王'], null);
    assert.equal(byName['群主本人'], '群主');

    // Editing later needs no name and cannot change it.
    const edit = await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明明', bio: '喜欢重策', wechatName: '老王' } });
    assert.equal(edit.status, 200);
    const after = await body<{ profile: { nickname: string; bio: string; wechatName: string } }>(await app.fetch('/api/me', { cookie }));
    assert.equal(after.profile.nickname, '小明明');
    assert.equal(after.profile.bio, '喜欢重策');
    assert.equal(after.profile.wechatName, '小明 🎲');

    // Unclaimed names can be deleted; claimed ones cannot.
    const laowang = list.names.find((n) => n.name === '老王') as InviteName;
    const xiaoming = list.names.find((n) => n.name === '小明 🎲') as InviteName;
    assert.equal((await app.fetch(`/api/admin/invite-names/${laowang.id}`, { method: 'DELETE', cookie: admin })).status, 204);
    assert.equal((await app.fetch(`/api/admin/invite-names/${xiaoming.id}`, { method: 'DELETE', cookie: admin })).status, 409);

    // Non-admins get 403 on the admin API.
    assert.equal((await app.fetch('/api/admin/invite-names', { cookie })).status, 403);
    assert.equal((await app.fetch('/api/admin/invite-names', { method: 'POST', cookie, json: { names: 'x' } })).status, 403);
  } finally {
    app.close();
  }
});

test('mutations from a foreign origin are rejected', async () => {
  const app = await testApp();
  try {
    const cookie = await app.member('dan@example.com');
    const res = await app.fetch('/api/profile', {
      method: 'PUT',
      cookie,
      json: { nickname: 'Dan' },
      headers: { Origin: 'https://evil.test' },
    });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error, 'bad_origin');
  } finally {
    app.close();
  }
});

test('the magic-link verify page does not use no-referrer (browsers would send Origin: null on the POST)', async () => {
  const app = await testApp();
  try {
    const res = await app.fetch('/auth/verify?token=abcdefghijklmnopqrstuvwxyz0123456789');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('referrer-policy'), 'origin');
    assert.match(await res.text(), /<form method="post"/);

    // And a POST that arrives with Origin: null is still refused.
    const nullOrigin = await app.fetch('/auth/verify', {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=abcdefghijklmnopqrstuvwxyz0123456789',
    });
    assert.equal(nullOrigin.status, 403);
  } finally {
    app.close();
  }
});

test('a name that is not on the list goes to the approval queue; admin approves or rejects', async () => {
  const app = await testApp();
  try {
    const admin = await app.admin();
    const cookie = await app.login('newbie@example.com');

    // Submit with an unlisted name → pending, and the site stays closed.
    const submitted = await expectJson<{ profile: { status: string; wechatName: string } }>(
      await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '新人', wechatName: '路人甲' } }),
      201,
    );
    assert.equal(submitted.profile.status, 'pending');
    const closed = await app.fetch('/api/events', { cookie });
    assert.equal(closed.status, 403);
    assert.equal((await body(closed)).error, 'approval_pending');

    // Admin sees it, with a count on /me.
    const me = await body<{ pendingRequests: number }>(await app.fetch('/api/me', { cookie: admin }));
    assert.equal(me.pendingRequests, 1);
    const list = await expectJson<{ requests: { userId: string; wechatName: string; email: string }[] }>(await app.fetch('/api/admin/requests', { cookie: admin }), 200);
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0]?.wechatName, '路人甲');
    assert.equal(list.requests[0]?.email, 'newbie@example.com');
    const userId = list.requests[0]?.userId as string;

    // Reject with a note: user sees it, can resubmit.
    const rejected = await expectJson<{ profile: { status: string; reviewNote: string } }>(
      await app.fetch(`/api/admin/requests/${userId}/reject`, { method: 'POST', cookie: admin, json: { note: '群里没这个人' } }),
      200,
    );
    assert.equal(rejected.profile.status, 'rejected');
    assert.equal(rejected.profile.reviewNote, '群里没这个人');
    assert.equal((await body(await app.fetch('/api/events', { cookie }))).error, 'approval_rejected');
    assert.equal((await app.fetch(`/api/admin/requests/${userId}/approve`, { method: 'POST', cookie: admin, json: {} })).status, 409);

    const again = await expectJson<{ profile: { status: string; reviewNote: string | null } }>(
      await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '新人', wechatName: '路人乙' } }),
      200,
    );
    assert.equal(again.profile.status, 'pending');
    assert.equal(again.profile.reviewNote, null);

    // Approve: the account opens and the name shows as registered on the list.
    const approved = await expectJson<{ profile: { status: string } }>(
      await app.fetch(`/api/admin/requests/${userId}/approve`, { method: 'POST', cookie: admin, json: {} }),
      200,
    );
    assert.equal(approved.profile.status, 'active');
    assert.equal((await app.fetch('/api/events', { cookie })).status, 200);
    const names = await expectJson<{ names: { name: string; claimedBy: { nickname: string } | null }[] }>(await app.fetch('/api/admin/invite-names', { cookie: admin }), 200);
    assert.equal(names.names.find((n) => n.name === '路人乙')?.claimedBy?.nickname, '新人');
    assert.equal((await body<{ pendingRequests: number }>(await app.fetch('/api/me', { cookie: admin }))).pendingRequests, 0);

    // Once active, the name can no longer be changed through the profile.
    await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '新人', wechatName: '别的' } });
    assert.equal((await body<{ profile: { wechatName: string } }>(await app.fetch('/api/me', { cookie }))).profile.wechatName, '路人乙');

    // Non-admins cannot touch the queue.
    assert.equal((await app.fetch('/api/admin/requests', { cookie })).status, 403);
  } finally {
    app.close();
  }
});

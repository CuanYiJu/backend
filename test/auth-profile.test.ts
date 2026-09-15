import { test } from 'node:test';
import assert from 'node:assert/strict';
import { body, expectJson, testApp } from './helpers.ts';
import type { ApprovalRequest, Member } from '../src/services/profiles.ts';

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

test('newcomers apply with a 打招呼 and wait; admins are active at once', async () => {
  const app = await testApp();
  try {
    const admin = await app.admin();
    const me = await body<{ isAdmin: boolean; profile: { status: string; wechatName: string } }>(await app.fetch('/api/me', { cookie: admin }));
    assert.equal(me.isAdmin, true);
    assert.equal(me.profile.status, 'active');

    const cookie = await app.login('bob@example.com');

    // Missing pieces.
    const noName = await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明', greeting: '你好' } });
    assert.equal(noName.status, 400);
    const noGreeting = await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明', wechatName: '小明🎲' } });
    assert.equal(noGreeting.status, 400);
    assert.match((await body(noGreeting)).message as string, /打个招呼/);
    const short = await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '明', wechatName: '小明🎲', greeting: '你好' } });
    assert.equal(short.status, 400);

    // Apply → pending, closed out of the app, greeting stored.
    const applied = await expectJson<{ profile: { status: string; greeting: string; wechatName: string } }>(
      await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明', wechatName: ' 小明🎲 ', greeting: '我是群里的小明，常玩德式' } }),
      201,
    );
    assert.equal(applied.profile.status, 'pending');
    assert.equal(applied.profile.wechatName, '小明🎲');
    assert.equal(applied.profile.greeting, '我是群里的小明，常玩德式');
    assert.equal((await body(await app.fetch('/api/events', { cookie }))).error, 'approval_pending');

    // Admin sees the greeting in the queue.
    const list = await expectJson<{ requests: ApprovalRequest[] }>(await app.fetch('/api/admin/requests', { cookie: admin }), 200);
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0]?.greeting, '我是群里的小明，常玩德式');
    assert.equal(list.requests[0]?.email, 'bob@example.com');

    // Editing while pending re-applies (still pending); once active only nickname/bio change.
    await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明明', wechatName: '小明🎲', greeting: '改了一下' } });
    await app.fetch(`/api/admin/requests/${list.requests[0]?.userId}/approve`, { method: 'POST', cookie: admin, json: {} });
    const edit = await app.fetch('/api/profile', { method: 'PUT', cookie, json: { nickname: '小明明明', bio: '喜欢重策', wechatName: '别的' } });
    assert.equal(edit.status, 200);
    const after = await body<{ profile: { nickname: string; bio: string; wechatName: string; status: string } }>(await app.fetch('/api/me', { cookie }));
    assert.equal(after.profile.status, 'active');
    assert.equal(after.profile.nickname, '小明明明');
    assert.equal(after.profile.bio, '喜欢重策');
    assert.equal(after.profile.wechatName, '小明🎲');

    // Non-admins get 403 on the admin API.
    assert.equal((await app.fetch('/api/admin/requests', { cookie })).status, 403);
    assert.equal((await app.fetch('/api/admin/members', { cookie })).status, 403);
  } finally {
    app.close();
  }
});

test('admin removes a member: access revoked, withdrawn from upcoming events, hosted events cancelled, may re-apply', async () => {
  const app = await testApp();
  try {
    const admin = await app.admin();
    const target = await app.member('t@example.com', '要走的人');
    const host = await app.member('h@example.com', '局长');
    const waiter = await app.member('w@example.com', '候补的');
    const baseEvent = { kind: 'adhoc', title: '局', location: '北约克', startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMin: 180, capacity: 2, minSize: 2 };

    // Target hosts one event and is confirmed (filling it) in another where someone waits.
    const own = (await expectJson<{ events: { id: string }[] }>(await app.fetch('/api/events', { method: 'POST', cookie: target, json: { ...baseEvent, title: '他组的局' } }), 201)).events[0]!;
    const other = (await expectJson<{ events: { id: string }[] }>(await app.fetch('/api/events', { method: 'POST', cookie: host, json: { ...baseEvent, title: '别人的局' } }), 201)).events[0]!;
    await app.fetch(`/api/events/${other.id}/join`, { method: 'POST', cookie: target, json: {} });
    const waitJoin = await expectJson<{ status: string }>(await app.fetch(`/api/events/${other.id}/join`, { method: 'POST', cookie: waiter, json: {} }), 200);
    assert.equal(waitJoin.status, 'waitlisted');

    const members = await expectJson<{ members: (Member & { isAdmin: boolean })[] }>(await app.fetch('/api/admin/members', { cookie: admin }), 200);
    const t = members.members.find((m) => m.email === 't@example.com') as Member;
    assert.ok(t);
    assert.equal(members.members.find((m) => m.email === 'admin@example.com')?.isAdmin, true);

    const removed = await expectJson<{ profile: { status: string; reviewNote: string }; cancelledEvents: number; withdrawnFrom: number }>(
      await app.fetch(`/api/admin/members/${t.userId}`, { method: 'DELETE', cookie: admin, json: { note: '不是群里的人' } }),
      200,
    );
    assert.equal(removed.profile.status, 'removed');
    assert.equal(removed.profile.reviewNote, '不是群里的人');
    assert.equal(removed.cancelledEvents, 1);
    assert.equal(removed.withdrawnFrom, 1);

    // Access revoked, with the reason.
    const closed = await app.fetch('/api/events', { cookie: target });
    assert.equal(closed.status, 403);
    assert.equal((await body(closed)).error, 'membership_removed');
    assert.equal((await body<{ profile: { status: string } }>(await app.fetch('/api/me', { cookie: target }))).profile.status, 'removed');

    // Effects on events: hosted one cancelled, waiter promoted into the vacated seat.
    const ownAfter = (await expectJson<{ event: { status: string; cancelReason: string } }>(await app.fetch(`/api/events/${own.id}`, { cookie: host }), 200)).event;
    assert.equal(ownAfter.status, 'cancelled');
    assert.equal(ownAfter.cancelReason, '组织者已被移出');
    const otherAfter = (await expectJson<{ event: { participants: { nickname: string; status: string }[] } }>(await app.fetch(`/api/events/${other.id}`, { cookie: host }), 200)).event;
    assert.deepEqual(otherAfter.participants.map((p) => `${p.nickname}:${p.status}`), ['局长:confirmed', '候补的:confirmed']);

    // Gone from the members list; re-applies with a greeting → pending again.
    const after = await expectJson<{ members: Member[] }>(await app.fetch('/api/admin/members', { cookie: admin }), 200);
    assert.equal(after.members.some((m) => m.email === 't@example.com'), false);
    const reapply = await expectJson<{ profile: { status: string } }>(
      await app.fetch('/api/profile', { method: 'PUT', cookie: target, json: { nickname: '要走的人', wechatName: 'wx-要走的人', greeting: '误会了，我是群里的' } }),
      200,
    );
    assert.equal(reapply.profile.status, 'pending');

    // Guards: not a member, self, another admin.
    assert.equal((await app.fetch(`/api/admin/members/${t.userId}`, { method: 'DELETE', cookie: admin, json: {} })).status, 409);
    const me = await body<{ user: { id: string } }>(await app.fetch('/api/me', { cookie: admin }));
    assert.equal((await body(await app.fetch(`/api/admin/members/${me.user.id}`, { method: 'DELETE', cookie: admin, json: {} }))).error, 'cannot_remove_self');
    const second = await app.login('second-admin@example.com');
    await app.fetch('/api/profile', { method: 'PUT', cookie: second, json: { nickname: '二群主', wechatName: '二群主' } });
    const secondId = (await body<{ user: { id: string } }>(await app.fetch('/api/me', { cookie: second }))).user.id;
    assert.equal((await body(await app.fetch(`/api/admin/members/${secondId}`, { method: 'DELETE', cookie: admin, json: {} }))).error, 'cannot_remove_admin');
    assert.equal((await app.fetch(`/api/admin/members/${t.userId}`, { method: 'DELETE', cookie: host, json: {} })).status, 403);
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

test('the magic-link verify page does not use no-referrer (browsers would send Origin: null on the POST; fixed upstream, guarded here)', async () => {
  const app = await testApp();
  try {
    const res = await app.fetch('/auth/verify?token=abcdefghijklmnopqrstuvwxyz0123456789');
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await res.text(), /<form method="post"/);

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

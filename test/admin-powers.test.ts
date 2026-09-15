import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEvent, body, expectJson, testApp } from './helpers.ts';
import type { EventDetail, EventSummary } from '../src/services/events.ts';

test('群主模式: admins manage any event only while the header is sent; members never', async () => {
  const app = await testApp();
  try {
    const admin = await app.admin();
    const host = await app.member('host@example.com', '局长');
    const player = await app.member('p@example.com', '阿花');
    const other = await app.member('o@example.com', '路人');
    const [event] = (await expectJson<{ events: EventSummary[] }>(await app.fetch('/api/events', { method: 'POST', cookie: host, json: { ...baseEvent, capacity: 3 } }), 201)).events;
    assert.ok(event);
    await app.fetch(`/api/events/${event.id}/join`, { method: 'POST', cookie: player, json: {} });

    // Off by default: the admin is an ordinary member on this event.
    const plain = (await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}`, { cookie: admin }), 200)).event;
    assert.equal(plain.isHost, false);
    assert.equal(plain.canManage, false);
    assert.equal((await app.fetch(`/api/events/${event.id}`, { method: 'PATCH', cookie: admin, json: { title: '偷偷改' } })).status, 403);
    assert.equal((await app.fetch(`/api/events/${event.id}/cancel`, { method: 'POST', cookie: admin, json: {} })).status, 403);

    // With the header: full host powers.
    const withMode = (await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}`, { cookie: admin, adminMode: true }), 200)).event;
    assert.equal(withMode.canManage, true);
    const list = (await expectJson<{ events: EventSummary[] }>(await app.fetch('/api/events', { cookie: admin, adminMode: true }), 200)).events;
    assert.equal(list[0]?.canManage, true);

    // The header does nothing for non-admins.
    const asOther = (await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}`, { cookie: other, adminMode: true }), 200)).event;
    assert.equal(asOther.canManage, false);
    assert.equal((await app.fetch(`/api/events/${event.id}`, { method: 'PATCH', cookie: other, adminMode: true, json: { title: '改名字' } })).status, 403);
    // The host manages their own event regardless.
    assert.equal((await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}`, { cookie: host }), 200)).event.canManage, true);

    // Admin edits, removes, cancels in 群主模式.
    const edited = await expectJson<{ event: EventSummary }>(await app.fetch(`/api/events/${event.id}`, { method: 'PATCH', cookie: admin, adminMode: true, json: { title: '群主改的名' } }), 200);
    assert.equal(edited.event.title, '群主改的名');
    const playerId = withMode.participants.find((p) => p.nickname === '阿花')?.userId as string;
    const removed = await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}/participants/${playerId}`, { method: 'DELETE', cookie: admin, adminMode: true }), 200);
    assert.deepEqual(removed.event.participants.map((p) => p.nickname), ['局长']);
    const cancelled = await expectJson<{ event: EventSummary }>(await app.fetch(`/api/events/${event.id}/cancel`, { method: 'POST', cookie: admin, adminMode: true, json: { reason: '群主取消' } }), 200);
    assert.equal(cancelled.event.status, 'cancelled');
    assert.equal(cancelled.event.cancelReason, '群主取消');
  } finally {
    app.close();
  }
});

test('admin adds a member by email: the account is active before first login', async () => {
  const app = await testApp();
  try {
    const admin = await app.admin();

    const added = await expectJson<{ profile: { nickname: string; wechatName: string; status: string }; email: string; created: boolean }>(
      await app.fetch('/api/admin/members', { method: 'POST', cookie: admin, json: { email: ' New@Example.com ', wechatName: '小新🌟' } }),
      201,
    );
    assert.equal(added.email, 'new@example.com');
    assert.equal(added.created, true);
    assert.equal(added.profile.status, 'active');
    assert.equal(added.profile.nickname, '小新🌟'); // defaults to the WeChat name

    // First login lands straight in the site: not a new user, profile active.
    const cookie = await app.login('new@example.com');
    const me = await body<{ profile: { status: string; nickname: string } }>(await app.fetch('/api/me', { cookie }));
    assert.equal(me.profile.status, 'active');
    assert.equal((await app.fetch('/api/events', { cookie })).status, 200);

    // Listed as a member.
    const members = await expectJson<{ members: { email: string }[] }>(await app.fetch('/api/admin/members', { cookie: admin }), 200);
    assert.ok(members.members.some((m) => m.email === 'new@example.com'));

    // Adding again is refused; a pending applicant is activated instead.
    const again = await app.fetch('/api/admin/members', { method: 'POST', cookie: admin, json: { email: 'new@example.com', wechatName: '小新🌟' } });
    assert.equal(again.status, 409);
    assert.equal((await body(again)).error, 'already_member');

    const pendingCookie = await app.applicant('pending@example.com', '等待中', '等等', '我是群里的');
    assert.equal((await body(await app.fetch('/api/events', { cookie: pendingCookie }))).error, 'approval_pending');
    const activated = await expectJson<{ profile: { status: string; nickname: string }; created: boolean }>(
      await app.fetch('/api/admin/members', { method: 'POST', cookie: admin, json: { email: 'pending@example.com', wechatName: '等等', nickname: '群主加的' } }),
      200,
    );
    assert.equal(activated.created, false);
    assert.equal(activated.profile.status, 'active');
    assert.equal(activated.profile.nickname, '群主加的');
    assert.equal((await app.fetch('/api/events', { cookie: pendingCookie })).status, 200);

    // Validation and permissions.
    assert.equal((await app.fetch('/api/admin/members', { method: 'POST', cookie: admin, json: { email: 'not-an-email', wechatName: 'x' } })).status, 400);
    assert.equal((await app.fetch('/api/admin/members', { method: 'POST', cookie: admin, json: { email: 'short@example.com', wechatName: '一' } })).status, 400);
    assert.equal((await app.fetch('/api/admin/members', { method: 'POST', cookie, json: { email: 'x@example.com', wechatName: '谁谁' } })).status, 403);
  } finally {
    app.close();
  }
});

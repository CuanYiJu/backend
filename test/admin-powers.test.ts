import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEvent, body, expectJson, testApp } from './helpers.ts';
import type { EventDetail, EventSummary } from '../src/services/events.ts';

test('admins can edit, cancel and remove players on any event; members still cannot', async () => {
  const app = await testApp();
  try {
    const admin = await app.admin();
    const host = await app.member('host@example.com', '局长');
    const player = await app.member('p@example.com', '阿花');
    const other = await app.member('o@example.com', '路人');
    const [event] = (await expectJson<{ events: EventSummary[] }>(await app.fetch('/api/events', { method: 'POST', cookie: host, json: { ...baseEvent, capacity: 3 } }), 201)).events;
    assert.ok(event);
    await app.fetch(`/api/events/${event.id}/join`, { method: 'POST', cookie: player, json: {} });

    // canManage is per viewer.
    const asAdmin = (await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}`, { cookie: admin }), 200)).event;
    assert.equal(asAdmin.isHost, false);
    assert.equal(asAdmin.canManage, true);
    const asOther = (await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}`, { cookie: other }), 200)).event;
    assert.equal(asOther.canManage, false);
    const asHost = (await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}`, { cookie: host }), 200)).event;
    assert.equal(asHost.canManage, true);
    const list = (await expectJson<{ events: EventSummary[] }>(await app.fetch('/api/events', { cookie: admin }), 200)).events;
    assert.equal(list[0]?.canManage, true);

    // Member who is not the host: refused.
    assert.equal((await app.fetch(`/api/events/${event.id}`, { method: 'PATCH', cookie: other, json: { title: '改名字' } })).status, 403);

    // Admin edits, removes, cancels.
    const edited = await expectJson<{ event: EventSummary }>(await app.fetch(`/api/events/${event.id}`, { method: 'PATCH', cookie: admin, json: { title: '群主改的名' } }), 200);
    assert.equal(edited.event.title, '群主改的名');
    const playerId = asAdmin.participants.find((p) => p.nickname === '阿花')?.userId as string;
    const removed = await expectJson<{ event: EventDetail }>(await app.fetch(`/api/events/${event.id}/participants/${playerId}`, { method: 'DELETE', cookie: admin }), 200);
    assert.deepEqual(removed.event.participants.map((p) => p.nickname), ['局长']);
    const cancelled = await expectJson<{ event: EventSummary }>(await app.fetch(`/api/events/${event.id}/cancel`, { method: 'POST', cookie: admin, json: { reason: '群主取消' } }), 200);
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
    assert.equal(added.profile.wechatName, '小新🌟');

    // First login lands straight in the site: not a new user, profile active.
    const cookie = await app.login('new@example.com');
    const me = await body<{ profile: { status: string; nickname: string } }>(await app.fetch('/api/me', { cookie }));
    assert.equal(me.profile.status, 'active');
    assert.equal((await app.fetch('/api/events', { cookie })).status, 200);

    // Shows on the list as registered.
    const names = await expectJson<{ names: { name: string; claimedBy: { nickname: string } | null }[] }>(await app.fetch('/api/admin/invite-names', { cookie: admin }), 200);
    assert.equal(names.names.find((n) => n.name === '小新🌟')?.claimedBy?.nickname, '小新🌟');

    // Adding again is refused; a pending applicant is activated instead.
    const again = await app.fetch('/api/admin/members', { method: 'POST', cookie: admin, json: { email: 'new@example.com', wechatName: '小新🌟' } });
    assert.equal(again.status, 409);
    assert.equal((await body(again)).error, 'already_member');

    const pendingCookie = await app.login('pending@example.com');
    await app.fetch('/api/profile', { method: 'PUT', cookie: pendingCookie, json: { nickname: '等待中', wechatName: '不在名单' } });
    assert.equal((await body(await app.fetch('/api/events', { cookie: pendingCookie }))).error, 'approval_pending');
    const activated = await expectJson<{ profile: { status: string; nickname: string }; created: boolean }>(
      await app.fetch('/api/admin/members', { method: 'POST', cookie: admin, json: { email: 'pending@example.com', wechatName: '不在名单', nickname: '群主加的' } }),
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

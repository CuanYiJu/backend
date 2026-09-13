import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEvent, body, expectJson, inHours, testApp, type TestApp } from './helpers.ts';
import type { EventDetail, EventSummary } from '../src/services/events.ts';

async function create(app: TestApp, cookie: string, overrides: Record<string, unknown> = {}): Promise<EventSummary[]> {
  const res = await app.fetch('/api/events', { method: 'POST', cookie, json: { ...baseEvent, ...overrides } });
  return (await expectJson<{ events: EventSummary[] }>(res, 201)).events;
}

async function detail(app: TestApp, cookie: string, id: string): Promise<EventDetail> {
  const res = await app.fetch(`/api/events/${id}`, { cookie });
  return (await expectJson<{ event: EventDetail }>(res, 200)).event;
}

const names = (d: EventDetail, status: 'confirmed' | 'waitlisted'): string[] =>
  d.participants.filter((p) => p.status === status).map((p) => p.nickname);

test('creating an event registers the host as the first confirmed player', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com', '局长');
    const [event] = await create(app, host);
    assert.ok(event);
    assert.equal(event.kind, 'adhoc');
    assert.equal(event.confirmedCount, 1);
    assert.equal(event.myStatus, 'confirmed');
    assert.equal(event.isHost, true);
    assert.equal(event.seriesId, null);

    const d = await detail(app, host, event.id);
    assert.deepEqual(names(d, 'confirmed'), ['局长']);

    const list = await body<{ events: EventSummary[] }>(await app.fetch('/api/events', { cookie: host }));
    assert.equal(list.events.length, 1);
    assert.equal(list.events[0]?.host.nickname, '局长');
  } finally {
    app.close();
  }
});

test('validation: title, capacity, past start time', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com');
    const bad = async (overrides: Record<string, unknown>, code: string) => {
      const res = await app.fetch('/api/events', { method: 'POST', cookie: host, json: { ...baseEvent, ...overrides } });
      assert.equal(res.status, 400);
      assert.equal((await body(res)).error, code);
    };
    await bad({ title: '局' }, 'validation');
    await bad({ capacity: 1 }, 'validation');
    await bad({ minSize: 5, capacity: 4 }, 'validation');
    await bad({ startsAt: 'not a date' }, 'bad_time');
    await bad({ startsAt: inHours(-48) }, 'bad_time');
  } finally {
    app.close();
  }
});

test('join fills seats then waitlists; leaving promotes the first in line', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com', '局长');
    const a = await app.member('a@example.com', '阿甲');
    const b = await app.member('b@example.com', '阿乙');
    const c = await app.member('c@example.com', '阿丙');
    const [event] = await create(app, host, { capacity: 3 });
    assert.ok(event);
    const id = event.id;

    const join = async (cookie: string) => body<{ status: string }>(await app.fetch(`/api/events/${id}/join`, { method: 'POST', cookie }));
    assert.equal((await join(a)).status, 'confirmed');
    assert.equal((await join(b)).status, 'confirmed');
    assert.equal((await join(c)).status, 'waitlisted');

    let d = await detail(app, host, id);
    assert.deepEqual(names(d, 'confirmed'), ['局长', '阿甲', '阿乙']);
    assert.deepEqual(names(d, 'waitlisted'), ['阿丙']);
    assert.equal(d.confirmedCount, 3);
    assert.equal(d.waitlistCount, 1);

    // Joining twice is refused.
    const twice = await app.fetch(`/api/events/${id}/join`, { method: 'POST', cookie: a });
    assert.equal(twice.status, 409);
    assert.equal((await body(twice)).error, 'already_joined');

    // A confirmed player leaves: the waitlisted one is promoted.
    const left = await body<{ promoted: string[] }>(await app.fetch(`/api/events/${id}/leave`, { method: 'POST', cookie: a }));
    assert.equal(left.promoted.length, 1);
    d = await detail(app, host, id);
    assert.deepEqual(names(d, 'confirmed'), ['局长', '阿乙', '阿丙']);
    assert.deepEqual(names(d, 'waitlisted'), []);

    // Re-joining after leaving goes to the back of the waitlist.
    assert.equal((await join(a)).status, 'waitlisted');
    // A waitlisted player leaving promotes nobody.
    const left2 = await body<{ promoted: string[] }>(await app.fetch(`/api/events/${id}/leave`, { method: 'POST', cookie: a }));
    assert.equal(left2.promoted.length, 0);

    // Leaving when not joined is an error.
    const notJoined = await app.fetch(`/api/events/${id}/leave`, { method: 'POST', cookie: a });
    assert.equal(notJoined.status, 409);

    // "mine" shows only what I host or joined.
    const mineA = await body<{ events: EventSummary[] }>(await app.fetch('/api/events?scope=mine', { cookie: a }));
    assert.equal(mineA.events.length, 0);
    const mineB = await body<{ events: EventSummary[] }>(await app.fetch('/api/events?scope=mine', { cookie: b }));
    assert.equal(mineB.events.length, 1);
    assert.equal(mineB.events[0]?.myStatus, 'confirmed');
  } finally {
    app.close();
  }
});

test('host can edit (raising capacity promotes), remove a player, and cancel', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com', '局长');
    const a = await app.member('a@example.com', '阿甲');
    const b = await app.member('b@example.com', '阿乙');
    const [event] = await create(app, host, { capacity: 2 });
    assert.ok(event);
    const id = event.id;
    await app.fetch(`/api/events/${id}/join`, { method: 'POST', cookie: a });
    await app.fetch(`/api/events/${id}/join`, { method: 'POST', cookie: b });
    let d = await detail(app, host, id);
    assert.deepEqual(names(d, 'waitlisted'), ['阿乙']);

    // Non-host cannot edit, cancel or remove.
    assert.equal((await app.fetch(`/api/events/${id}`, { method: 'PATCH', cookie: a, json: { title: '改名' } })).status, 403);
    assert.equal((await app.fetch(`/api/events/${id}/cancel`, { method: 'POST', cookie: a, json: {} })).status, 403);
    assert.equal((await app.fetch(`/api/events/${id}/participants/${d.host.id}`, { method: 'DELETE', cookie: a })).status, 403);

    // Raising capacity promotes from the waitlist.
    const edited = await app.fetch(`/api/events/${id}`, { method: 'PATCH', cookie: host, json: { title: '改名了', capacity: 3 } });
    await expectJson(edited, 200);
    d = await detail(app, host, id);
    assert.equal(d.title, '改名了');
    assert.deepEqual(names(d, 'confirmed'), ['局长', '阿甲', '阿乙']);

    // Host removes a player.
    const aId = d.participants.find((p) => p.nickname === '阿甲')?.userId as string;
    const removed = await app.fetch(`/api/events/${id}/participants/${aId}`, { method: 'DELETE', cookie: host });
    await expectJson(removed, 200);
    d = await detail(app, host, id);
    assert.deepEqual(names(d, 'confirmed'), ['局长', '阿乙']);
    // The removed player sees they are no longer registered and may rejoin.
    const forA = await detail(app, a, id);
    assert.equal(forA.myStatus, 'removed');

    // Cancel: hidden from upcoming, joins refused, still in "mine".
    const cancelled = await app.fetch(`/api/events/${id}/cancel`, { method: 'POST', cookie: host, json: { reason: '场地没了' } });
    assert.equal(cancelled.status, 200);
    d = await detail(app, host, id);
    assert.equal(d.status, 'cancelled');
    assert.equal(d.cancelReason, '场地没了');
    assert.equal(d.isPast, true);
    const upcoming = await body<{ events: EventSummary[] }>(await app.fetch('/api/events', { cookie: host }));
    assert.equal(upcoming.events.length, 0);
    const joinCancelled = await app.fetch(`/api/events/${id}/join`, { method: 'POST', cookie: a });
    assert.equal(joinCancelled.status, 409);
    assert.equal((await body(joinCancelled)).error, 'event_cancelled');
    const mine = await body<{ events: EventSummary[] }>(await app.fetch('/api/events?scope=mine', { cookie: host }));
    assert.equal(mine.events.length, 1);
    assert.equal((await app.fetch(`/api/events/${id}`, { method: 'PATCH', cookie: host, json: { title: '改回去' } })).status, 409);
  } finally {
    app.close();
  }
});

test('a weekly game night creates one event per week sharing a series id', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com', '局长');
    const events = await create(app, host, { kind: 'regular', title: '周四固定局', repeatWeeks: 4 });
    assert.equal(events.length, 4);
    const series = new Set(events.map((e) => e.seriesId));
    assert.equal(series.size, 1);
    assert.notEqual(events[0]?.seriesId, null);
    const starts = events.map((e) => new Date(e.startsAt).getTime());
    for (let i = 1; i < starts.length; i++) assert.equal(starts[i]! - starts[i - 1]!, 7 * 24 * 3_600_000);
    for (const e of events) assert.equal(e.confirmedCount, 1);

    // Cancelling one occurrence leaves the rest.
    await app.fetch(`/api/events/${events[1]!.id}/cancel`, { method: 'POST', cookie: host, json: {} });
    const upcoming = await body<{ events: EventSummary[] }>(await app.fetch('/api/events', { cookie: host }));
    assert.equal(upcoming.events.length, 3);
  } finally {
    app.close();
  }
});

test('past events leave the upcoming list and refuse joins', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com', '局长');
    const a = await app.member('a@example.com', '阿甲');
    // Started 50 minutes ago (within the 1h grace for creation), 30 min long: already over.
    const [event] = await create(app, host, { startsAt: inHours(-50 / 60), durationMin: 30 });
    assert.ok(event);
    assert.equal(event.isPast, true);
    const upcoming = await body<{ events: EventSummary[] }>(await app.fetch('/api/events', { cookie: host }));
    assert.equal(upcoming.events.length, 0);
    const past = await body<{ events: EventSummary[] }>(await app.fetch('/api/events?scope=past', { cookie: host }));
    assert.equal(past.events.length, 1);
    const res = await app.fetch(`/api/events/${event.id}/join`, { method: 'POST', cookie: a });
    assert.equal(res.status, 409);
    assert.equal((await body(res)).error, 'event_over');
  } finally {
    app.close();
  }
});

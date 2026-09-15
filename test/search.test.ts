import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEvent, body, expectJson, inHours, testApp } from './helpers.ts';
import type { EventSummary } from '../src/services/events.ts';

async function search(app: Awaited<ReturnType<typeof testApp>>, cookie: string, q: string): Promise<string[]> {
  const res = await app.fetch(`/api/events/search?q=${encodeURIComponent(q)}`, { cookie });
  return (await expectJson<{ events: EventSummary[] }>(res, 200)).events.map((e) => e.title);
}

test('search matches title, games, description, location, host and participant names; case-insensitive', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com', '局长', '王局长');
    const player = await app.member('p@example.com', '阿花', '花花🌸');
    const create = async (over: Record<string, unknown>) =>
      (await expectJson<{ events: EventSummary[] }>(await app.fetch('/api/events', { method: 'POST', cookie: host, json: { ...baseEvent, ...over } }), 201)).events[0]!;

    const catan = await create({ title: '周六卡坦岛', games: 'Catan 海洋', description: '新手友好，带零食', location: '北约克 Meeple' });
    await create({ title: '周日狼人杀', games: '狼人杀', description: null, location: '万锦 我家' });
    await app.fetch(`/api/events/${catan.id}/join`, { method: 'POST', cookie: player, json: {} });

    assert.deepEqual(await search(app, host, '卡坦'), ['周六卡坦岛']);
    assert.deepEqual(await search(app, host, 'catan'), ['周六卡坦岛']); // games, case-insensitive
    assert.deepEqual(await search(app, host, '零食'), ['周六卡坦岛']); // description
    assert.deepEqual(await search(app, host, '万锦'), ['周日狼人杀']); // location
    assert.deepEqual((await search(app, host, '局长')).sort(), ['周六卡坦岛', '周日狼人杀']); // host nickname
    assert.deepEqual((await search(app, host, '王局长')).sort(), ['周六卡坦岛', '周日狼人杀']); // host WeChat name
    assert.deepEqual(await search(app, host, '阿花'), ['周六卡坦岛']); // participant nickname
    assert.deepEqual(await search(app, host, '花花'), ['周六卡坦岛']); // participant WeChat name
    assert.deepEqual(await search(app, host, '不存在'), []);
    assert.deepEqual(await search(app, host, '   '), []);

    // LIKE wildcards are literal.
    assert.deepEqual(await search(app, host, '%'), []);
    assert.deepEqual(await search(app, host, '_'), []);

    const tooLong = await app.fetch(`/api/events/search?q=${'x'.repeat(51)}`, { cookie: host });
    assert.equal(tooLong.status, 400);
    assert.equal((await body(tooLong)).error, 'validation');
  } finally {
    app.close();
  }
});

test('past and cancelled events appear only for people who hosted or were confirmed', async () => {
  const app = await testApp();
  try {
    const host = await app.member('host@example.com', '局长');
    const player = await app.member('p@example.com', '阿花');
    const waiter = await app.member('w@example.com', '阿草');
    const outsider = await app.member('o@example.com', '路人');
    const create = async (over: Record<string, unknown>) =>
      (await expectJson<{ events: EventSummary[] }>(await app.fetch('/api/events', { method: 'POST', cookie: host, json: { ...baseEvent, ...over } }), 201)).events[0]!;

    // Started 50 minutes ago, 30 minutes long: already over. Capacity 2 = host + one.
    const past = await create({ title: '昨天的卡坦', startsAt: inHours(-50 / 60), durationMin: 30, capacity: 2 });
    // Joins are refused on past events, so seat people before the end: create as future, join, then it cannot become past in-test.
    // Instead use a second event that is still open, join, then cancel it (cancelled counts as history).
    const cancelled = await create({ title: '取消的卡坦', capacity: 2 });
    await app.fetch(`/api/events/${cancelled.id}/join`, { method: 'POST', cookie: player, json: {} });
    await app.fetch(`/api/events/${cancelled.id}/join`, { method: 'POST', cookie: waiter, json: {} }); // waitlisted
    await app.fetch(`/api/events/${cancelled.id}/cancel`, { method: 'POST', cookie: host, json: {} });
    const open = await create({ title: '下周的卡坦' });

    // Host sees everything they hosted.
    assert.deepEqual(await search(app, host, '卡坦'), ['下周的卡坦', '取消的卡坦', '昨天的卡坦']);
    // Confirmed player sees the cancelled one (was confirmed) plus the open one, not the past one they never joined.
    assert.deepEqual(await search(app, player, '卡坦'), ['下周的卡坦', '取消的卡坦']);
    // Waitlisted does not count as participation for history.
    assert.deepEqual(await search(app, waiter, '卡坦'), ['下周的卡坦']);
    // Outsider only sees upcoming.
    assert.deepEqual(await search(app, outsider, '卡坦'), ['下周的卡坦']);
    assert.equal(past.isPast, true);
    assert.equal(open.isPast, false);
  } finally {
    app.close();
  }
});

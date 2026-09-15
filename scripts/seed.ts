/**
 * Demo data for local development: a few group members and 局 of each kind.
 *
 *   npm run seed
 *
 * Safe to run while `npm run dev` is up (SQLite WAL). Re-running adds more
 * events but reuses the demo members. Never run against production.
 */
import { loadConfig } from '../src/config.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { migrate } from '../src/db/migrate.ts';
import { addMember } from '../src/services/profiles.ts';
import { createEvent, joinEvent } from '../src/services/events.ts';

const config = loadConfig();
if (config.nodeEnv === 'production') throw new Error('seed: refusing to run in production');
const db = new SqliteDb(config.databaseFile);
await migrate(db);

const members: { email: string; nickname: string; wechatName: string }[] = [
  { email: 'demo-a@example.com', nickname: '阿甲', wechatName: '甲甲' },
  { email: 'demo-b@example.com', nickname: '阿乙', wechatName: '乙乙' },
  { email: 'demo-c@example.com', nickname: '阿丙', wechatName: '丙丙' },
  { email: 'demo-d@example.com', nickname: '阿丁', wechatName: '丁丁' },
];

const now = new Date();
// As if the admin had added them directly on /admin.
const ids: string[] = [];
for (const m of members) {
  const { rows } = await db.query<{ id: string }>('select id from users where email = $1', [m.email]);
  if (rows[0]) {
    ids.push(rows[0].id);
    continue;
  }
  const { profile } = await addMember(db, { email: m.email, wechatName: m.wechatName, nickname: m.nickname }, now);
  ids.push(profile.userId);
}
const [a, b, c, d] = ids as [string, string, string, string];

const at = (daysFromNow: number, hour: number): string => {
  const t = new Date(now);
  t.setDate(t.getDate() + daysFromNow);
  t.setHours(hour, 0, 0, 0);
  return t.toISOString();
};

// A weekly game night hosted by 阿甲, three weeks out.
const weekly = await createEvent(
  db,
  a,
  {
    kind: 'regular',
    title: '周四晚固定局',
    games: '到了再定，通常是中策',
    description: '每周四晚上的固定局，新手友好。桌游吧有饮料，人均 $10 左右现场 AA。',
    location: '北约克 Meeple 桌游吧',
    startsAt: at(((4 - now.getDay() + 7) % 7) || 7, 19),
    durationMin: 240,
    capacity: 6,
    minSize: 3,
    repeatWeeks: 3,
  },
  now,
);
await joinEvent(db, weekly[0]!.id, b, now);
await joinEvent(db, weekly[0]!.id, c, now);

// A small ad-hoc request that is already full, with a waitlist.
const [small] = await createEvent(
  db,
  b,
  {
    kind: 'adhoc',
    title: '求人：三人卡坦岛',
    games: '卡坦岛（海洋扩展）',
    description: '我家，有猫。带零食就行。',
    location: '万锦 我家',
    startsAt: at(2, 14),
    durationMin: 180,
    capacity: 3,
    minSize: 3,
    repeatWeeks: 1,
  },
  now,
);
await joinEvent(db, small!.id, c, now);
await joinEvent(db, small!.id, d, now);
await joinEvent(db, small!.id, a, now); // → waitlist

// A big one with room.
await createEvent(
  db,
  c,
  {
    kind: 'adhoc',
    title: '周六下午重策局：农场主 / 殖民火星',
    games: '农场主、殖民火星、大西部之路',
    description: '想开重策的来。会玩的教不会玩的，慢慢来。',
    location: 'Downtown 某桌游吧（报名后群里说）',
    startsAt: at(((6 - now.getDay() + 7) % 7) || 7, 13),
    durationMin: 300,
    capacity: 8,
    minSize: 4,
    repeatWeeks: 1,
  },
  now,
);

// One that already happened, for the "已结束" tab.
await createEvent(
  db,
  d,
  {
    kind: 'adhoc',
    title: '上周的狼人杀',
    games: '狼人杀',
    location: '士嘉宝 某桌游吧',
    startsAt: at(-6, 19),
    durationMin: 180,
    capacity: 10,
    minSize: 6,
    repeatWeeks: 1,
  },
  new Date(now.getTime() - 7 * 24 * 3_600_000),
);

console.log(`seeded ${members.length} demo members and 6 events into ${config.databaseFile}`);
db.close();

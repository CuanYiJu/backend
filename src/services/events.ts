import type { SqlClient } from '../magic-link.ts';
import type { Db, Statement } from '../db/types.ts';
import { ApiError, forbidden, notFound } from '../errors.ts';
import { iso } from './profiles.ts';

/** regular = 固定局 (recurring game night); adhoc = 临时局 / 求局 (one-off play request). */
export type EventKind = 'regular' | 'adhoc';
export type EventStatus = 'open' | 'cancelled';
/** withdrawn = left on their own; removed = taken off the list by the host. */
export type RegistrationStatus = 'confirmed' | 'waitlisted' | 'withdrawn' | 'removed';

export interface EventSummary {
  id: string;
  seriesId: string | null;
  kind: EventKind;
  title: string;
  games: string | null;
  description: string | null;
  location: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  capacity: number;
  minSize: number;
  status: EventStatus;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  host: { id: string; nickname: string };
  confirmedCount: number;
  waitlistCount: number;
  /** The viewer's own registration, if any. */
  myStatus: RegistrationStatus | null;
  isHost: boolean;
  /** The viewer may edit, cancel and remove players: the host, or an admin. */
  canManage: boolean;
  /** No more joins: cancelled or already over. */
  isPast: boolean;
}

export interface Participant {
  userId: string;
  nickname: string;
  wechatName: string | null;
  status: 'confirmed' | 'waitlisted';
  joinedAt: string;
}

export interface EventDetail extends EventSummary {
  participants: Participant[];
}

export interface CreateEventInput {
  kind: EventKind;
  title: string;
  games?: string | null;
  description?: string | null;
  location: string;
  startsAt: string;
  durationMin: number;
  capacity: number;
  minSize: number;
  /** Weekly occurrences to create, sharing one series id. 1 = just this one. */
  repeatWeeks: number;
}

export interface UpdateEventInput {
  title?: string | undefined;
  games?: string | null | undefined;
  description?: string | null | undefined;
  location?: string | undefined;
  startsAt?: string | undefined;
  durationMin?: number | undefined;
  capacity?: number | undefined;
  minSize?: number | undefined;
}

export type ListScope = 'upcoming' | 'past' | 'mine';

/** Who is asking. Admins get host powers on every event. */
export interface ViewerOptions {
  isAdmin?: boolean;
}

interface EventRow {
  id: string;
  host_id: string;
  series_id: string | null;
  kind: EventKind;
  title: string;
  games: string | null;
  description: string | null;
  location: string;
  starts_at: string | Date;
  duration_min: number;
  capacity: number;
  min_size: number;
  status: EventStatus;
  cancel_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  host_nickname: string;
  confirmed_count: number | string;
  waitlist_count: number | string;
  my_status: RegistrationStatus | null;
}

const SELECT_EVENT = `
  select e.*, p.nickname as host_nickname,
    (select count(*) from registrations r where r.event_id = e.id and r.status = 'confirmed') as confirmed_count,
    (select count(*) from registrations r where r.event_id = e.id and r.status = 'waitlisted') as waitlist_count,
    (select r.status from registrations r where r.event_id = e.id and r.user_id = $1) as my_status
  from events e
  join profiles p on p.user_id = e.host_id`;

/**
 * Fill free seats from the waitlist in queue order, as one statement, so it
 * is race-free on SQLite and D1 alike (neither has interactive
 * transactions in our setup). A negative free-seat count selects nothing,
 * which is how "host lowered capacity" never demotes anyone.
 * Params: $1 event id, $2 now. Returns the promoted user ids.
 */
const PROMOTE_SQL = `
  update registrations set status = 'confirmed', updated_at = $2
  where id in (
    select id from (
      select id, row_number() over (order by position asc) as rn
      from registrations where event_id = $1 and status = 'waitlisted'
    )
    where rn <= (select capacity from events where id = $1)
              - (select count(*) from registrations where event_id = $1 and status = 'confirmed')
  )
  and (select status from events where id = $1) = 'open'
  returning user_id`;

/**
 * Join as confirmed if a seat is free, else waitlisted, deciding inside the
 * statement so two simultaneous joins cannot both take the last seat. A
 * previous withdrawn/removed row is reused with a new position at the back
 * of the queue; an active row is left alone and returns nothing.
 * Params: $1 new id, $2 event id, $3 user id, $4 now.
 */
const JOIN_SQL = `
  insert into registrations (id, event_id, user_id, status, position, created_at, updated_at)
  select $1, $2, $3,
    case when (select count(*) from registrations where event_id = $2 and status = 'confirmed')
            < (select capacity from events where id = $2) then 'confirmed' else 'waitlisted' end,
    coalesce((select max(position) from registrations where event_id = $2), 0) + 1,
    $4, $4
  where true
  on conflict (event_id, user_id) do update set
    status = excluded.status, position = excluded.position, created_at = excluded.created_at, updated_at = excluded.updated_at
  where registrations.status not in ('confirmed', 'waitlisted')
  returning status`;

const promote = (eventId: string, now: Date): Statement => ({ text: PROMOTE_SQL, params: [eventId, now.toISOString()] });

const newId = (): string => crypto.randomUUID();

function endOf(startsAt: string | Date, durationMin: number): Date {
  return new Date(new Date(startsAt).getTime() + durationMin * 60_000);
}

function fromRow(r: EventRow, viewerId: string | null, now: Date, isAdmin = false): EventSummary {
  const endsAt = endOf(r.starts_at, r.duration_min);
  return {
    id: r.id,
    seriesId: r.series_id,
    kind: r.kind,
    title: r.title,
    games: r.games,
    description: r.description,
    location: r.location,
    startsAt: iso(r.starts_at),
    endsAt: endsAt.toISOString(),
    durationMin: r.duration_min,
    capacity: r.capacity,
    minSize: r.min_size,
    status: r.status,
    cancelReason: r.cancel_reason,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    host: { id: r.host_id, nickname: r.host_nickname },
    confirmedCount: Number(r.confirmed_count),
    waitlistCount: Number(r.waitlist_count),
    myStatus: r.my_status,
    isHost: viewerId === r.host_id,
    canManage: viewerId === r.host_id || isAdmin,
    isPast: r.status === 'cancelled' || endsAt <= now,
  };
}

/** Events longer than this are not expected; used to bound the "still running" window. */
const MAX_EVENT_HOURS = 24;

export async function listEvents(db: SqlClient, scope: ListScope, viewerId: string, now: Date = new Date(), viewer: ViewerOptions = {}): Promise<EventSummary[]> {
  const windowStart = new Date(now.getTime() - MAX_EVENT_HOURS * 3_600_000);
  let sql: string;
  let params: unknown[];
  switch (scope) {
    case 'upcoming':
      sql = `${SELECT_EVENT} where e.status = 'open' and e.starts_at >= $2 order by e.starts_at asc, e.created_at asc limit 200`;
      params = [viewerId, windowStart.toISOString()];
      break;
    case 'past':
      sql = `${SELECT_EVENT} where e.starts_at < $2 order by e.starts_at desc limit 100`;
      params = [viewerId, now.toISOString()];
      break;
    case 'mine':
      sql = `${SELECT_EVENT}
        where e.host_id = $1
           or exists (select 1 from registrations r where r.event_id = e.id and r.user_id = $1 and r.status in ('confirmed', 'waitlisted'))
        order by e.starts_at asc limit 200`;
      params = [viewerId];
      break;
  }
  const { rows } = await db.query<EventRow>(sql, params);
  const events = rows.map((r) => fromRow(r, viewerId, now, viewer.isAdmin));
  if (scope === 'upcoming') return events.filter((e) => !e.isPast);
  if (scope === 'past') return events.filter((e) => e.isPast);
  return events;
}

/** Escape LIKE wildcards in user input; the query uses `escape '\\'`. */
function likePattern(q: string): string {
  return '%' + q.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
}

/**
 * Free-text search over title, games, description, location, and the
 * nicknames / WeChat names of the host and active participants. Upcoming
 * events are searched for everyone; past or cancelled ones only where the
 * viewer hosted or was confirmed — other people's history stays private.
 * Upcoming results first (soonest first), then history (latest first).
 */
export async function searchEvents(db: SqlClient, q: string, viewerId: string, now: Date = new Date(), viewer: ViewerOptions = {}): Promise<EventSummary[]> {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const pattern = likePattern(term);
  const windowStart = new Date(now.getTime() - MAX_EVENT_HOURS * 3_600_000);
  const { rows } = await db.query<EventRow>(
    `${SELECT_EVENT}
     where (
       lower(e.title) like $2 escape '\\'
       or lower(coalesce(e.games, '')) like $2 escape '\\'
       or lower(coalesce(e.description, '')) like $2 escape '\\'
       or lower(e.location) like $2 escape '\\'
       or lower(p.nickname) like $2 escape '\\'
       or lower(p.wechat_name) like $2 escape '\\'
       or exists (
         select 1 from registrations r join profiles pp on pp.user_id = r.user_id
         where r.event_id = e.id and r.status in ('confirmed', 'waitlisted')
           and (lower(pp.nickname) like $2 escape '\\' or lower(pp.wechat_name) like $2 escape '\\')
       )
     )
     and (
       (e.status = 'open' and e.starts_at >= $3)
       or e.host_id = $1
       or exists (select 1 from registrations r where r.event_id = e.id and r.user_id = $1 and r.status = 'confirmed')
     )
     order by e.starts_at desc limit 300`,
    [viewerId, pattern, windowStart.toISOString()],
  );
  const events = rows.map((r) => fromRow(r, viewerId, now, viewer.isAdmin));
  // The SQL window is generous; apply the exact rule here: past or cancelled
  // only when the viewer hosted or was confirmed.
  const visible = events.filter((e) => !e.isPast || e.isHost || e.myStatus === 'confirmed');
  const upcoming = visible.filter((e) => !e.isPast).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const history = visible.filter((e) => e.isPast);
  return [...upcoming, ...history].slice(0, 100);
}

async function loadEvent(db: SqlClient, id: string, viewerId: string | null, now: Date, isAdmin = false): Promise<EventSummary | null> {
  const { rows } = await db.query<EventRow>(`${SELECT_EVENT} where e.id = $2`, [viewerId, id]);
  return rows[0] ? fromRow(rows[0], viewerId, now, isAdmin) : null;
}

export async function getEvent(db: SqlClient, id: string, viewerId: string, now: Date = new Date(), viewer: ViewerOptions = {}): Promise<EventDetail> {
  const event = await loadEvent(db, id, viewerId, now, viewer.isAdmin);
  if (!event) throw notFound();
  const { rows } = await db.query<{ user_id: string; nickname: string; wechat_name: string | null; status: 'confirmed' | 'waitlisted'; created_at: string | Date }>(
    `select r.user_id, p.nickname, p.wechat_name, r.status, r.created_at
     from registrations r join profiles p on p.user_id = r.user_id
     where r.event_id = $1 and r.status in ('confirmed', 'waitlisted')
     order by case r.status when 'confirmed' then 0 else 1 end, r.position asc`,
    [id],
  );
  return {
    ...event,
    participants: rows.map((r) => ({
      userId: r.user_id,
      nickname: r.nickname,
      wechatName: r.wechat_name,
      status: r.status,
      joinedAt: iso(r.created_at),
    })),
  };
}

/**
 * Create one event, or `repeatWeeks` weekly occurrences that share a series
 * id. The host is registered as the first confirmed player of each one.
 */
export async function createEvent(db: Db, hostId: string, input: CreateEventInput, now: Date = new Date()): Promise<EventSummary[]> {
  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime())) throw new ApiError(400, 'bad_time', '开始时间格式不对。');
  if (start.getTime() < now.getTime() - 60 * 60_000) throw new ApiError(400, 'bad_time', '开始时间已经过了。');
  const weeks = Math.max(1, input.repeatWeeks);
  const seriesId = weeks > 1 ? newId() : null;
  const at = now.toISOString();
  const ids: string[] = [];
  const statements: Statement[] = [];
  for (let i = 0; i < weeks; i++) {
    const id = newId();
    const startsAt = new Date(start.getTime() + i * 7 * 24 * 3_600_000).toISOString();
    statements.push({
      text: `insert into events (id, host_id, series_id, kind, title, games, description, location, starts_at, duration_min, capacity, min_size, status, cancel_reason, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', null, $13, $13)`,
      params: [id, hostId, seriesId, input.kind, input.title, input.games ?? null, input.description ?? null, input.location, startsAt, input.durationMin, input.capacity, input.minSize, at],
    });
    statements.push({
      text: `insert into registrations (id, event_id, user_id, status, position, created_at, updated_at) values ($1, $2, $3, 'confirmed', 1, $4, $4)`,
      params: [newId(), id, hostId, at],
    });
    ids.push(id);
  }
  await db.batch(statements);
  const created: EventSummary[] = [];
  for (const id of ids) {
    const e = await loadEvent(db, id, hostId, now);
    if (e) created.push(e);
  }
  return created;
}

/** The host, or an admin, may manage the event. */
async function requireManager(db: SqlClient, id: string, userId: string, now: Date, viewer: ViewerOptions): Promise<EventSummary> {
  const event = await loadEvent(db, id, userId, now, viewer.isAdmin);
  if (!event) throw notFound();
  if (!event.canManage) throw forbidden('只有组织者或群主可以这样做。');
  return event;
}

export async function updateEvent(db: Db, id: string, hostId: string, patch: UpdateEventInput, now: Date = new Date(), viewer: ViewerOptions = {}): Promise<EventSummary> {
  const event = await requireManager(db, id, hostId, now, viewer);
  if (event.status === 'cancelled') throw new ApiError(409, 'event_cancelled', '这个局已取消，不能再改。');
  const next = {
    title: patch.title ?? event.title,
    games: patch.games === undefined ? event.games : patch.games,
    description: patch.description === undefined ? event.description : patch.description,
    location: patch.location ?? event.location,
    startsAt: patch.startsAt ?? event.startsAt,
    durationMin: patch.durationMin ?? event.durationMin,
    capacity: patch.capacity ?? event.capacity,
    minSize: patch.minSize ?? event.minSize,
  };
  if (Number.isNaN(new Date(next.startsAt).getTime())) throw new ApiError(400, 'bad_time', '开始时间格式不对。');
  await db.batch([
    {
      text: `update events set title = $2, games = $3, description = $4, location = $5, starts_at = $6, duration_min = $7, capacity = $8, min_size = $9, updated_at = $10
             where id = $1`,
      params: [id, next.title, next.games, next.description, next.location, new Date(next.startsAt).toISOString(), next.durationMin, next.capacity, next.minSize, now.toISOString()],
    },
    promote(id, now), // fills seats if capacity went up; no-op otherwise
  ]);
  const updated = await loadEvent(db, id, hostId, now, viewer.isAdmin);
  if (!updated) throw notFound();
  return updated;
}

export async function cancelEvent(db: SqlClient, id: string, hostId: string, reason: string | null, now: Date = new Date(), viewer: ViewerOptions = {}): Promise<EventSummary> {
  const event = await requireManager(db, id, hostId, now, viewer);
  if (event.status !== 'cancelled') {
    await db.query(`update events set status = 'cancelled', cancel_reason = $2, updated_at = $3 where id = $1`, [id, reason, now.toISOString()]);
  }
  const updated = await loadEvent(db, id, hostId, now, viewer.isAdmin);
  if (!updated) throw notFound();
  return updated;
}

function alreadyJoined(status: RegistrationStatus | null): never {
  throw new ApiError(409, 'already_joined', status === 'confirmed' ? '你已经报名了。' : '你已经在候补里了。');
}

export async function joinEvent(db: Db, eventId: string, userId: string, now: Date = new Date()): Promise<{ status: 'confirmed' | 'waitlisted' }> {
  const event = await loadEvent(db, eventId, userId, now);
  if (!event) throw notFound();
  if (event.status === 'cancelled') throw new ApiError(409, 'event_cancelled', '这个局已经取消了。');
  if (event.isPast) throw new ApiError(409, 'event_over', '这个局已经结束了。');
  if (event.myStatus === 'confirmed' || event.myStatus === 'waitlisted') alreadyJoined(event.myStatus);

  const { rows } = await db.query<{ status: 'confirmed' | 'waitlisted' }>(JOIN_SQL, [newId(), eventId, userId, now.toISOString()]);
  const row = rows[0];
  if (!row) {
    // Lost a race with our own double-click: the row is already active.
    const again = await loadEvent(db, eventId, userId, now);
    return alreadyJoined(again?.myStatus ?? null);
  }
  return { status: row.status };
}

export async function leaveEvent(db: Db, eventId: string, userId: string, now: Date = new Date()): Promise<{ promoted: string[] }> {
  const event = await loadEvent(db, eventId, userId, now);
  if (!event) throw notFound();
  if (event.myStatus !== 'confirmed' && event.myStatus !== 'waitlisted') {
    throw new ApiError(409, 'not_joined', '你没有报名这个局。');
  }
  const [left, promoted] = await db.batch<{ user_id: string }>([
    {
      text: `update registrations set status = 'withdrawn', updated_at = $3
             where event_id = $1 and user_id = $2 and status in ('confirmed', 'waitlisted') returning user_id`,
      params: [eventId, userId, now.toISOString()],
    },
    promote(eventId, now),
  ]);
  if (!left?.rows.length) throw new ApiError(409, 'not_joined', '你没有报名这个局。');
  return { promoted: promoted?.rows.map((r) => r.user_id) ?? [] };
}

export async function removeParticipant(db: Db, eventId: string, hostId: string, targetUserId: string, now: Date = new Date(), viewer: ViewerOptions = {}): Promise<{ promoted: string[] }> {
  await requireManager(db, eventId, hostId, now, viewer);
  const [removed, promoted] = await db.batch<{ user_id: string }>([
    {
      text: `update registrations set status = 'removed', updated_at = $3
             where event_id = $1 and user_id = $2 and status in ('confirmed', 'waitlisted') returning user_id`,
      params: [eventId, targetUserId, now.toISOString()],
    },
    promote(eventId, now),
  ]);
  if (!removed?.rows.length) throw new ApiError(409, 'not_joined', '这个人不在名单里。');
  return { promoted: promoted?.rows.map((r) => r.user_id) ?? [] };
}

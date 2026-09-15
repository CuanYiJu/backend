import type { SqlClient } from '../magic-link.ts';
import type { Db, Statement } from '../db/types.ts';
import { ApiError } from '../errors.ts';

/**
 * pending  = applied with a 打招呼, waiting for the admin
 * active   = member
 * rejected = admin said no; may apply again
 * removed  = admin took them out; may apply again
 */
export type ProfileStatus = 'pending' | 'active' | 'rejected' | 'removed';

export interface Profile {
  userId: string;
  nickname: string;
  /** The member's WeChat name (微信昵称), so the admin can match them to the group. */
  wechatName: string;
  /** The 打招呼 they applied with. */
  greeting: string | null;
  bio: string | null;
  status: ProfileStatus;
  /** Admin's note on rejection / removal, shown to the user. */
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  nickname: string;
  /** Required while applying; ignored once active. */
  wechatName?: string | null;
  /** Required while applying (non-admins); ignored once active. */
  greeting?: string | null;
  bio?: string | null;
}

/** A pending application as the admin sees it. */
export interface ApprovalRequest {
  userId: string;
  nickname: string;
  wechatName: string;
  greeting: string | null;
  email: string;
  requestedAt: string;
}

/** An active member as the admin sees it. */
export interface Member {
  userId: string;
  nickname: string;
  wechatName: string;
  email: string;
  joinedAt: string;
}

interface ProfileRow {
  user_id: string;
  nickname: string;
  wechat_name: string;
  greeting: string | null;
  bio: string | null;
  status: ProfileStatus;
  review_note: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export const iso = (v: string | Date): string => new Date(v).toISOString();

/** Fold case, whitespace and full-width forms so the admin's eyes and the DB agree on a name. */
export function normalizeWechatName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s​-‍⁠﻿]+/g, '')
    .toLowerCase();
}

function fromRow(r: ProfileRow): Profile {
  return {
    userId: r.user_id,
    nickname: r.nickname,
    wechatName: r.wechat_name,
    greeting: r.greeting,
    bio: r.bio,
    status: r.status,
    reviewNote: r.review_note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function getProfile(db: SqlClient, userId: string): Promise<Profile | null> {
  const { rows } = await db.query<ProfileRow>('select * from profiles where user_id = $1', [userId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

async function mustGet(db: SqlClient, userId: string): Promise<Profile> {
  const profile = await getProfile(db, userId);
  if (!profile) throw new Error('profiles: row missing after write');
  return profile;
}

/**
 * Apply (or re-apply) for membership, or edit an active profile.
 * Non-admins always wait for the admin; admins are active at once.
 */
export async function upsertProfile(
  db: SqlClient,
  userId: string,
  input: ProfileInput,
  isAdmin: boolean,
  now: Date = new Date(),
): Promise<{ profile: Profile; created: boolean }> {
  const existing = await getProfile(db, userId);
  const at = now.toISOString();

  if (existing?.status === 'active') {
    await db.query('update profiles set nickname = $2, bio = $3, updated_at = $4 where user_id = $1', [userId, input.nickname, input.bio ?? null, at]);
    return { profile: await mustGet(db, userId), created: false };
  }

  const wechatName = (input.wechatName ?? '').trim();
  if (!wechatName) throw new ApiError(400, 'validation', '请填写微信名。');
  const greeting = (input.greeting ?? '').trim() || null;
  if (!isAdmin && !greeting) throw new ApiError(400, 'validation', '打个招呼吧，让群主知道你是谁。');
  const status: ProfileStatus = isAdmin ? 'active' : 'pending';

  if (existing) {
    await db.query(
      `update profiles set nickname = $2, wechat_name = $3, greeting = $4, bio = $5, invite_code = $6, status = $7, review_note = null, updated_at = $8 where user_id = $1`,
      [userId, input.nickname, wechatName, greeting, input.bio ?? null, normalizeWechatName(wechatName), status, at],
    );
  } else {
    await db.query(
      `insert into profiles (user_id, nickname, wechat_name, greeting, bio, invite_code, status, review_note, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, null, $8, $8)`,
      [userId, input.nickname, wechatName, greeting, input.bio ?? null, normalizeWechatName(wechatName), status, at],
    );
  }
  return { profile: await mustGet(db, userId), created: !existing };
}

export interface AddMemberInput {
  email: string;
  wechatName: string;
  nickname?: string | null;
}

/**
 * Admin adds a member directly by email: the account exists and is active
 * before the person ever logs in, so their first login goes straight to
 * the site. Also activates a pending / rejected / removed profile.
 */
export async function addMember(db: SqlClient, input: AddMemberInput, now: Date = new Date()): Promise<{ profile: Profile; email: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const wechatName = input.wechatName.trim();
  const nickname = (input.nickname ?? wechatName).trim().slice(0, 20);
  if (nickname.length < 2) throw new ApiError(400, 'validation', '站内昵称 2–20 个字；微信名太短时请填一个昵称。');
  const at = now.toISOString();

  await db.query(`insert into users (id, email, created_at) values ($1, $2, $3) on conflict (email) do nothing`, [crypto.randomUUID(), email, at]);
  const { rows } = await db.query<{ id: string }>('select id from users where email = $1', [email]);
  const userId = rows[0]?.id;
  if (!userId) throw new Error('profiles: user row missing after insert');

  const existing = await getProfile(db, userId);
  if (existing?.status === 'active') throw new ApiError(409, 'already_member', `${email} 已经是成员了。`);

  if (existing) {
    await db.query(
      `update profiles set nickname = $2, wechat_name = $3, invite_code = $4, status = 'active', review_note = null, updated_at = $5 where user_id = $1`,
      [userId, nickname, wechatName, normalizeWechatName(wechatName), at],
    );
  } else {
    await db.query(
      `insert into profiles (user_id, nickname, wechat_name, greeting, bio, invite_code, status, review_note, created_at, updated_at)
       values ($1, $2, $3, null, null, $4, 'active', null, $5, $5)`,
      [userId, nickname, wechatName, normalizeWechatName(wechatName), at],
    );
  }
  return { profile: await mustGet(db, userId), email, created: !existing };
}

export async function listApprovalRequests(db: SqlClient): Promise<ApprovalRequest[]> {
  const { rows } = await db.query<{ user_id: string; nickname: string; wechat_name: string; greeting: string | null; email: string; updated_at: string | Date }>(
    `select p.user_id, p.nickname, p.wechat_name, p.greeting, u.email, p.updated_at
     from profiles p join users u on u.id = p.user_id
     where p.status = 'pending' order by p.updated_at asc`,
  );
  return rows.map((r) => ({ userId: r.user_id, nickname: r.nickname, wechatName: r.wechat_name, greeting: r.greeting, email: r.email, requestedAt: iso(r.updated_at) }));
}

export async function countApprovalRequests(db: SqlClient): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>(`select count(*) as n from profiles where status = 'pending'`);
  return Number(rows[0]?.n ?? 0);
}

export async function approveRequest(db: SqlClient, userId: string, now: Date = new Date()): Promise<Profile> {
  const profile = await getProfile(db, userId);
  if (!profile) throw new ApiError(404, 'not_found', '没有这个申请。');
  if (profile.status !== 'pending') throw new ApiError(409, 'not_pending', '这个申请已经处理过了。');
  await db.query(`update profiles set status = 'active', review_note = null, updated_at = $2 where user_id = $1`, [userId, now.toISOString()]);
  return mustGet(db, userId);
}

export async function rejectRequest(db: SqlClient, userId: string, note: string | null, now: Date = new Date()): Promise<Profile> {
  const profile = await getProfile(db, userId);
  if (!profile) throw new ApiError(404, 'not_found', '没有这个申请。');
  if (profile.status !== 'pending') throw new ApiError(409, 'not_pending', '这个申请已经处理过了。');
  await db.query(`update profiles set status = 'rejected', review_note = $2, updated_at = $3 where user_id = $1`, [userId, note, now.toISOString()]);
  return mustGet(db, userId);
}

export async function listMembers(db: SqlClient): Promise<Member[]> {
  const { rows } = await db.query<{ user_id: string; nickname: string; wechat_name: string; email: string; created_at: string | Date }>(
    `select p.user_id, p.nickname, p.wechat_name, u.email, p.created_at
     from profiles p join users u on u.id = p.user_id
     where p.status = 'active' order by p.created_at desc`,
  );
  return rows.map((r) => ({ userId: r.user_id, nickname: r.nickname, wechatName: r.wechat_name, email: r.email, joinedAt: iso(r.created_at) }));
}

/**
 * Take a member out: they lose access, are withdrawn from every upcoming
 * event (waitlists promoted), and the open events they host are cancelled.
 * Their account stays, so they can apply again and the admin decides anew.
 */
export async function removeMember(db: Db, userId: string, note: string | null, now: Date = new Date()): Promise<{ profile: Profile; cancelledEvents: number; withdrawnFrom: number }> {
  const profile = await getProfile(db, userId);
  if (!profile) throw new ApiError(404, 'not_found', '没有这个成员。');
  if (profile.status !== 'active') throw new ApiError(409, 'not_member', '这个人不是成员。');
  const at = now.toISOString();

  const { rows: hosted } = await db.query<{ id: string }>(
    `select id from events where host_id = $1 and status = 'open' and starts_at >= $2`,
    [userId, at],
  );
  const { rows: joined } = await db.query<{ event_id: string }>(
    `select r.event_id from registrations r join events e on e.id = r.event_id
     where r.user_id = $1 and r.status in ('confirmed', 'waitlisted') and e.status = 'open' and e.starts_at >= $2 and e.host_id <> $1`,
    [userId, at],
  );

  const statements: Statement[] = [
    { text: `update profiles set status = 'removed', review_note = $2, updated_at = $3 where user_id = $1`, params: [userId, note, at] },
    ...hosted.map((e): Statement => ({
      text: `update events set status = 'cancelled', cancel_reason = '组织者已被移出', updated_at = $2 where id = $1 and status = 'open'`,
      params: [e.id, at],
    })),
    ...joined.flatMap((r): Statement[] => [
      { text: `update registrations set status = 'withdrawn', updated_at = $3 where event_id = $1 and user_id = $2`, params: [r.event_id, userId, at] },
      { text: PROMOTE_AFTER_REMOVAL_SQL, params: [r.event_id, at] },
    ]),
  ];
  await db.batch(statements);
  return { profile: await mustGet(db, userId), cancelledEvents: hosted.length, withdrawnFrom: joined.length };
}

/** Same as PROMOTE_SQL in events.ts; duplicated to avoid a circular import. */
const PROMOTE_AFTER_REMOVAL_SQL = `
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

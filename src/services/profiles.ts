import type { SqlClient } from '../magic-link.ts';
import { ApiError } from '../errors.ts';
import { normalizeWechatName, recordClaimedName, tryClaimInviteName } from './invites.ts';

/** pending = waiting for an admin (name was not on the list); rejected = admin said no, may resubmit. */
export type ProfileStatus = 'pending' | 'active' | 'rejected';

export interface Profile {
  userId: string;
  nickname: string;
  /** The member's WeChat name (微信昵称). Fixed once the profile is active. */
  wechatName: string;
  bio: string | null;
  status: ProfileStatus;
  /** Admin's note on rejection, shown to the user. */
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  nickname: string;
  /** Required the first time and while pending / rejected; ignored once active. */
  wechatName?: string | null;
  bio?: string | null;
}

/** A pending profile as the admin sees it. */
export interface ApprovalRequest {
  userId: string;
  nickname: string;
  wechatName: string;
  email: string;
  requestedAt: string;
}

interface ProfileRow {
  user_id: string;
  nickname: string;
  wechat_name: string;
  bio: string | null;
  status: ProfileStatus;
  review_note: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export const iso = (v: string | Date): string => new Date(v).toISOString();

function fromRow(r: ProfileRow): Profile {
  return {
    userId: r.user_id,
    nickname: r.nickname,
    wechatName: r.wechat_name,
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
 * First time: claim the WeChat name from the admin's list → active. Not on
 * the list (or already taken) → saved as pending for the admin to review.
 * Admins are always active. While pending or rejected the user may resubmit
 * with a different name; once active only nickname and bio change.
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

  const typed = (input.wechatName ?? '').trim();
  if (!typed) throw new ApiError(400, 'validation', '请填写微信名。');
  let name = typed;
  let status: ProfileStatus = 'pending';
  if (isAdmin) {
    await recordClaimedName(db, userId, typed, now);
    status = 'active';
  } else {
    const claim = await tryClaimInviteName(db, userId, typed, now);
    if (claim.outcome === 'claimed') {
      name = claim.name;
      status = 'active';
    }
  }

  if (existing) {
    await db.query(
      `update profiles set nickname = $2, wechat_name = $3, bio = $4, invite_code = $5, status = $6, review_note = null, updated_at = $7 where user_id = $1`,
      [userId, input.nickname, name, input.bio ?? null, normalizeWechatName(name), status, at],
    );
  } else {
    await db.query(
      `insert into profiles (user_id, nickname, wechat_name, bio, invite_code, status, review_note, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, null, $7, $7)`,
      [userId, input.nickname, name, input.bio ?? null, normalizeWechatName(name), status, at],
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
 * the site with no invitation name and no approval. Also activates a
 * pending / rejected profile for that email.
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

  await recordClaimedName(db, userId, wechatName, now);
  if (existing) {
    await db.query(
      `update profiles set nickname = $2, wechat_name = $3, invite_code = $4, status = 'active', review_note = null, updated_at = $5 where user_id = $1`,
      [userId, nickname, wechatName, normalizeWechatName(wechatName), at],
    );
  } else {
    await db.query(
      `insert into profiles (user_id, nickname, wechat_name, bio, invite_code, status, review_note, created_at, updated_at)
       values ($1, $2, $3, null, $4, 'active', null, $5, $5)`,
      [userId, nickname, wechatName, normalizeWechatName(wechatName), at],
    );
  }
  return { profile: await mustGet(db, userId), email, created: !existing };
}

export async function listApprovalRequests(db: SqlClient): Promise<ApprovalRequest[]> {
  const { rows } = await db.query<{ user_id: string; nickname: string; wechat_name: string; email: string; updated_at: string | Date }>(
    `select p.user_id, p.nickname, p.wechat_name, u.email, p.updated_at
     from profiles p join users u on u.id = p.user_id
     where p.status = 'pending' order by p.updated_at asc`,
  );
  return rows.map((r) => ({ userId: r.user_id, nickname: r.nickname, wechatName: r.wechat_name, email: r.email, requestedAt: iso(r.updated_at) }));
}

export async function countApprovalRequests(db: SqlClient): Promise<number> {
  const { rows } = await db.query<{ n: number | string }>(`select count(*) as n from profiles where status = 'pending'`);
  return Number(rows[0]?.n ?? 0);
}

export async function approveRequest(db: SqlClient, userId: string, now: Date = new Date()): Promise<Profile> {
  const profile = await getProfile(db, userId);
  if (!profile) throw new ApiError(404, 'not_found', '没有这个申请。');
  if (profile.status !== 'pending') throw new ApiError(409, 'not_pending', '这个申请已经处理过了。');
  await recordClaimedName(db, userId, profile.wechatName, now);
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

import type { SqlClient } from '../magic-link.ts';
import { ApiError } from '../errors.ts';
import { iso } from './profiles.ts';

/**
 * Membership is checked against the group members' WeChat names (微信昵称,
 * the name on the member's own profile, not their per-group nickname). The
 * admin pastes the list; a newcomer types their name and claims the entry.
 * Names that are not on the list go to the approval queue (see profiles.ts).
 * Names are not secrets and not unique in the world, so this is a friction
 * gate against strangers, not authentication.
 */

export interface InviteName {
  id: string;
  name: string;
  createdAt: string;
  claimedBy: { userId: string; nickname: string } | null;
  claimedAt: string | null;
}

interface InviteRow {
  id: string;
  name: string;
  created_at: string | Date;
  claimed_by: string | null;
  claimed_at: string | Date | null;
  claimant_nickname: string | null;
}

/**
 * Typed from a phone, compared forgivingly: ignore case, all whitespace and
 * invisible characters, fold full-width forms. Emoji are kept (they are
 * often the only thing distinguishing two "小王"s).
 */
export function normalizeWechatName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s​-‍⁠﻿]+/g, '')
    .toLowerCase();
}

/** Split pasted text on newlines and common separators. */
export function parseNameList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\r\n,，、;；]+/)) {
    const name = part.trim();
    if (!name) continue;
    const key = normalizeWechatName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function fromRow(r: InviteRow): InviteName {
  return {
    id: r.id,
    name: r.name,
    createdAt: iso(r.created_at),
    claimedBy: r.claimed_by ? { userId: r.claimed_by, nickname: r.claimant_nickname ?? '' } : null,
    claimedAt: r.claimed_at ? iso(r.claimed_at) : null,
  };
}

const SELECT = `
  select i.id, i.name, i.created_at, i.claimed_by, i.claimed_at, p.nickname as claimant_nickname
  from invite_names i left join profiles p on p.user_id = i.claimed_by`;

export async function listInviteNames(db: SqlClient): Promise<InviteName[]> {
  const { rows } = await db.query<InviteRow>(`${SELECT} order by i.claimed_at is not null, i.created_at desc, i.name asc`);
  return rows.map(fromRow);
}

export async function addInviteNames(
  db: SqlClient,
  addedBy: string | null,
  text: string,
  now: Date = new Date(),
): Promise<{ added: InviteName[]; duplicates: string[] }> {
  const added: InviteName[] = [];
  const duplicates: string[] = [];
  for (const name of parseNameList(text)) {
    const { rows } = await db.query<{ id: string }>(
      `insert into invite_names (id, name, normalized, added_by, created_at) values ($1, $2, $3, $4, $5)
       on conflict (normalized) do nothing returning id`,
      [crypto.randomUUID(), name, normalizeWechatName(name), addedBy, now.toISOString()],
    );
    if (!rows[0]) {
      duplicates.push(name);
      continue;
    }
    const full = await db.query<InviteRow>(`${SELECT} where i.id = $1`, [rows[0].id]);
    if (full.rows[0]) added.push(fromRow(full.rows[0]));
  }
  return { added, duplicates };
}

export async function removeInviteName(db: SqlClient, id: string): Promise<void> {
  const { rows } = await db.query<{ claimed_by: string | null }>('select claimed_by from invite_names where id = $1', [id]);
  const row = rows[0];
  if (!row) throw new ApiError(404, 'not_found', '没有这个名字。');
  if (row.claimed_by) throw new ApiError(409, 'claimed', '这个名字已经有人用了，不能删。');
  await db.query('delete from invite_names where id = $1', [id]);
}

export type ClaimResult =
  /** Matched an entry that was free (or already ours); `name` is as the admin typed it. */
  | { outcome: 'claimed'; name: string }
  | { outcome: 'not_found' }
  | { outcome: 'taken' };

/** Atomically claim the list entry for the user, if there is a free one. */
export async function tryClaimInviteName(db: SqlClient, userId: string, wechatName: string, now: Date = new Date()): Promise<ClaimResult> {
  const normalized = normalizeWechatName(wechatName);
  if (!normalized) throw new ApiError(400, 'validation', '请填写微信名。');
  const claimed = await db.query<{ name: string }>(
    `update invite_names set claimed_by = $2, claimed_at = coalesce(claimed_at, $3)
     where normalized = $1 and (claimed_by is null or claimed_by = $2) returning name`,
    [normalized, userId, now.toISOString()],
  );
  if (claimed.rows[0]) return { outcome: 'claimed', name: claimed.rows[0].name };
  const existing = await db.query<{ id: string }>('select id from invite_names where normalized = $1', [normalized]);
  return existing.rows[0] ? { outcome: 'taken' } : { outcome: 'not_found' };
}

/**
 * Record a name as claimed by the user without needing it on the list:
 * admins onboarding, and approved requests. Claims a free entry of that
 * name if one exists, otherwise adds one; never steals another user's.
 */
export async function recordClaimedName(db: SqlClient, userId: string, wechatName: string, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  await db.query(
    `insert into invite_names (id, name, normalized, added_by, created_at, claimed_by, claimed_at) values ($1, $2, $3, $4, $5, $4, $5)
     on conflict (normalized) do update set claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at
     where invite_names.claimed_by is null`,
    [crypto.randomUUID(), wechatName.trim(), normalizeWechatName(wechatName), userId, at],
  );
}

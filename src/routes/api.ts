import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/types.ts';
import type { AppConfig } from '../config.ts';
import type { Auth } from '../auth.ts';
import { ApiError, forbidden, profileRequired, unauthenticated } from '../errors.ts';
import {
  addMember,
  approveRequest,
  countApprovalRequests,
  getProfile,
  listApprovalRequests,
  listMembers,
  rejectRequest,
  removeMember,
  upsertProfile,
  type Profile,
} from '../services/profiles.ts';
import {
  cancelEvent,
  createEvent,
  getEvent,
  joinEvent,
  leaveEvent,
  listEvents,
  removeParticipant,
  searchEvents,
  updateEvent,
} from '../services/events.ts';

export interface ApiDeps {
  config: AppConfig;
  db: Db;
  auth: Auth;
}

/**
 * Admins only get host powers on other people's events while "群主模式" is
 * on, which the client signals per request with this header. Off by
 * default, so an admin browsing normally cannot change anything by accident.
 */
export const ADMIN_MODE_HEADER = 'x-admin-mode';

type Env = {
  Variables: {
    userId: string | null;
    email: string | null;
    isAdmin: boolean;
    adminMode: boolean;
    profile: Profile | null;
  };
};

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  trimmed(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const profileSchema = z.object({
  nickname: trimmed(20).min(2, '昵称 2–20 个字。'),
  wechatName: optionalText(40),
  greeting: optionalText(300),
  bio: optionalText(200),
});

const eventFields = {
  title: trimmed(40).min(2, '标题 2–40 个字。'),
  games: optionalText(100),
  description: optionalText(2000),
  location: trimmed(100).min(1, '请填写地点。'),
  startsAt: z.string().min(1, '请选择开始时间。'),
  durationMin: z.number().int().min(30).max(24 * 60),
  capacity: z.number().int().min(2, '人数上限至少 2 人。').max(200),
  minSize: z.number().int().min(2).max(200),
};

const createEventSchema = z
  .object({
    kind: z.enum(['regular', 'adhoc']),
    ...eventFields,
    repeatWeeks: z.number().int().min(1).max(12).default(1),
  })
  .refine((v) => v.minSize <= v.capacity, { message: '最低成局人数不能超过人数上限。', path: ['minSize'] });

const updateEventSchema = z.object({
  title: eventFields.title.optional(),
  games: eventFields.games,
  description: eventFields.description,
  location: eventFields.location.optional(),
  startsAt: eventFields.startsAt.optional(),
  durationMin: eventFields.durationMin.optional(),
  capacity: eventFields.capacity.optional(),
  minSize: eventFields.minSize.optional(),
});

const cancelSchema = z.object({ reason: optionalText(200) });
const noteSchema = z.object({ note: optionalText(200) });
const addMemberSchema = z.object({
  email: z.string().trim().email('请填写正确的邮箱。').max(254),
  wechatName: trimmed(40).min(1, '请填写微信名。'),
  nickname: optionalText(20),
});

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const data: unknown = await c.req.json().catch(() => null);
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, 'validation', first?.message ?? '输入有误。');
  }
  return result.data;
}

export function createApiRoutes({ config, db, auth }: ApiDeps): Hono<Env> {
  const api = new Hono<Env>();
  const allowedOrigins = new Set([config.magicLink.baseUrl]);
  const admins = new Set(config.adminEmails);

  // Session, profile and admin flags for every request. Mutations also check
  // Origin, the same CSRF rule the magic-link routes apply (SameSite=Lax
  // does the rest).
  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin') ?? refererOrigin(c.req.header('referer'));
      if (!origin || !allowedOrigins.has(origin)) throw new ApiError(403, 'bad_origin', '请求来源不对。');
    }
    const session = await auth.handlers.getSession(c.req.raw);
    let email: string | null = null;
    if (session) {
      const { rows } = await db.query<{ email: string }>('select email from users where id = $1', [session.userId]);
      email = rows[0]?.email ?? null;
    }
    const isAdmin = email !== null && admins.has(email);
    c.set('userId', session?.userId ?? null);
    c.set('email', email);
    c.set('isAdmin', isAdmin);
    c.set('adminMode', isAdmin && c.req.header(ADMIN_MODE_HEADER) === '1');
    c.set('profile', session ? await getProfile(db, session.userId) : null);
    await next();
  });

  api.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'internal', message: '服务器出了点问题，请稍后再试。' }, 500);
  });

  const requireUser = (c: Context<Env>): string => {
    const userId = c.get('userId');
    if (!userId) throw unauthenticated();
    return userId;
  };
  const requireMember = (c: Context<Env>): string => {
    const userId = requireUser(c);
    const profile = c.get('profile');
    if (!profile) throw profileRequired();
    if (profile.status === 'pending') throw new ApiError(403, 'approval_pending', '群主还没审核，请稍等。');
    if (profile.status === 'rejected') throw new ApiError(403, 'approval_rejected', '群主没有通过你的申请。');
    if (profile.status === 'removed') throw new ApiError(403, 'membership_removed', '你已经不在这个群的成员里了。');
    return userId;
  };
  const requireAdmin = (c: Context<Env>): string => {
    const userId = requireUser(c);
    if (!c.get('isAdmin')) throw forbidden('只有群主可以这样做。');
    return userId;
  };
  /** Host powers beyond one's own events only in admin mode. */
  const viewer = (c: Context<Env>) => ({ isAdmin: c.get('adminMode') });

  api.get('/me', async (c) => {
    const userId = requireUser(c);
    const isAdmin = c.get('isAdmin');
    return c.json({
      user: { id: userId, email: c.get('email') ?? '' },
      profile: c.get('profile'),
      isAdmin,
      pendingRequests: isAdmin ? await countApprovalRequests(db) : 0,
    });
  });

  api.put('/profile', async (c) => {
    const userId = requireUser(c);
    const input = await parseBody(c, profileSchema);
    const { profile, created } = await upsertProfile(db, userId, input, c.get('isAdmin'));
    return c.json({ profile }, created ? 201 : 200);
  });

  // ── admin: membership ────────────────────────────────────────────────

  api.get('/admin/members', async (c) => {
    requireAdmin(c);
    const members = await listMembers(db);
    return c.json({ members: members.map((m) => ({ ...m, isAdmin: admins.has(m.email) })) });
  });

  api.post('/admin/members', async (c) => {
    requireAdmin(c);
    const input = await parseBody(c, addMemberSchema);
    const result = await addMember(db, input);
    return c.json(result, result.created ? 201 : 200);
  });

  api.delete('/admin/members/:userId', async (c) => {
    const adminId = requireAdmin(c);
    const target = c.req.param('userId');
    if (target === adminId) throw new ApiError(409, 'cannot_remove_self', '不能移出自己。');
    const { rows } = await db.query<{ email: string }>('select email from users where id = $1', [target]);
    if (rows[0] && admins.has(rows[0].email)) throw new ApiError(409, 'cannot_remove_admin', '不能移出群主。');
    const { note } = await parseBody(c, noteSchema);
    return c.json(await removeMember(db, target, note));
  });

  api.get('/admin/requests', async (c) => {
    requireAdmin(c);
    return c.json({ requests: await listApprovalRequests(db) });
  });

  api.post('/admin/requests/:userId/approve', async (c) => {
    requireAdmin(c);
    return c.json({ profile: await approveRequest(db, c.req.param('userId')) });
  });

  api.post('/admin/requests/:userId/reject', async (c) => {
    requireAdmin(c);
    const { note } = await parseBody(c, noteSchema);
    return c.json({ profile: await rejectRequest(db, c.req.param('userId'), note) });
  });

  // ── events ───────────────────────────────────────────────────────────

  api.get('/events', async (c) => {
    const userId = requireMember(c);
    const scope = c.req.query('scope');
    if (scope !== undefined && scope !== 'upcoming' && scope !== 'past' && scope !== 'mine') {
      throw new ApiError(400, 'validation', 'scope 只能是 upcoming / past / mine。');
    }
    return c.json({ events: await listEvents(db, scope ?? 'upcoming', userId, new Date(), viewer(c)) });
  });

  // Before /events/:id so "search" is not taken for an id.
  api.get('/events/search', async (c) => {
    const userId = requireMember(c);
    const q = (c.req.query('q') ?? '').trim();
    if (q.length > 50) throw new ApiError(400, 'validation', '搜索词太长了。');
    return c.json({ events: q ? await searchEvents(db, q, userId, new Date(), viewer(c)) : [] });
  });

  api.post('/events', async (c) => {
    const userId = requireMember(c);
    const input = await parseBody(c, createEventSchema);
    const events = await createEvent(db, userId, input);
    return c.json({ events }, 201);
  });

  api.get('/events/:id', async (c) => {
    const userId = requireMember(c);
    return c.json({ event: await getEvent(db, c.req.param('id'), userId, new Date(), viewer(c)) });
  });

  api.patch('/events/:id', async (c) => {
    const userId = requireMember(c);
    const patch = await parseBody(c, updateEventSchema);
    return c.json({ event: await updateEvent(db, c.req.param('id'), userId, patch, new Date(), viewer(c)) });
  });

  api.post('/events/:id/cancel', async (c) => {
    const userId = requireMember(c);
    const { reason } = await parseBody(c, cancelSchema);
    return c.json({ event: await cancelEvent(db, c.req.param('id'), userId, reason, new Date(), viewer(c)) });
  });

  api.post('/events/:id/join', async (c) => {
    const userId = requireMember(c);
    const id = c.req.param('id');
    const result = await joinEvent(db, id, userId);
    return c.json({ ...result, event: await getEvent(db, id, userId, new Date(), viewer(c)) });
  });

  api.post('/events/:id/leave', async (c) => {
    const userId = requireMember(c);
    const id = c.req.param('id');
    const result = await leaveEvent(db, id, userId);
    return c.json({ ...result, event: await getEvent(db, id, userId, new Date(), viewer(c)) });
  });

  api.delete('/events/:id/participants/:userId', async (c) => {
    const hostId = requireMember(c);
    const id = c.req.param('id');
    const result = await removeParticipant(db, id, hostId, c.req.param('userId'), new Date(), viewer(c));
    return c.json({ ...result, event: await getEvent(db, id, hostId, new Date(), viewer(c)) });
  });

  api.notFound((c) => c.json({ error: 'not_found', message: '接口不存在。' }, 404));
  return api;
}

function refererOrigin(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

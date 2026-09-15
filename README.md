# 开局 · 桌游群 — backend

API for a WeChat boardgame group's 组局 site: recurring game nights (固定局), one-off play requests (临时局), sign-ups with a waitlist, and passwordless email login. Membership is gated by a list of the group members' WeChat names that the admin maintains: a newcomer types their own WeChat name; if it matches an unclaimed entry they are in immediately, otherwise the profile waits in an approval queue for the admin.

**Stack**: TypeScript on [Hono](https://hono.dev), runnable two ways from the same code: locally on Node ≥ 22.18 (no build step, SQLite through the built-in `node:sqlite`) and in production as a Cloudflare Worker with D1. Login comes from the sibling [`magic-link`](../../magic-link) package. Zero native dependencies.

## Layout

This repo expects the magic-link package two directories up, exactly as its README describes:

```
src/
├── magic-link/          passwordless login package (own repo)
└── site/
    ├── backend/         this repo
    └── frontend/        Vite + React app (own repo)
```

`src/magic-link.ts` is the only file that knows that path.

## Run

```bash
cd ../../magic-link && npm install      # once; the login package needs its own deps
cd ../site/backend && npm install
cp .env.example .env                    # edit INVITE_CODES at least
npm run dev                             # http://localhost:8787, restarts on change
```

Without a `.env` the server still starts with dev defaults (admin `admin@example.com`, login emails printed to the terminal, database at `./data/kaiju.sqlite`) and warns about each one. In production every value in `.env.example` is required.

```bash
npm run seed      # demo members + events for local development
npm run check     # tsc + tests (in-memory SQLite, no services needed)
```

Then start the frontend (`../frontend`, `npm run dev`) and open <http://localhost:5173>. The Vite dev server proxies `/api` and `/auth` here, so the browser sees one origin — that origin is `APP_BASE_URL`, which the magic-link package uses to build links and to check `Origin` on POSTs.

## API

All JSON. Errors are `{ error, message }` with a Chinese `message` ready to show. Auth errors from the magic-link routes use `{ status, message }` instead.

| Method · path | Needs | Does |
|---|---|---|
| `POST /auth/magic-link` `{ email }` | — | Send login email (link + 6-digit code). Always 202. |
| `GET /auth/verify?token=` / `POST /auth/verify` | — | Link login → 303 with session cookie. |
| `POST /auth/verify-code` `{ email, code, next? }` | — | Code login → `{ redirectTo, isNew }` with cookie. |
| `POST /auth/logout` | — | Clear session. |
| `GET /api/me` | login | `{ user: { id, email }, profile \| null }`. 401 when logged out. |
| `PUT /api/profile` `{ nickname, wechatName?, bio? }` | login | Create (201). `wechatName` on the list and free → `status: active`; otherwise `status: pending` for the admin. Admins are always active. While pending / rejected the user may resubmit (200) with another name; once active only nickname / bio change. |
| `POST /api/admin/members` `{ email, wechatName, nickname? }` | admin | Add a member directly: creates the account (if new) with an active profile, so that email logs straight in. 409 if already an active member. |
| `GET /api/admin/requests` | admin | Pending profiles: nickname, WeChat name, email, time. |
| `POST /api/admin/requests/:userId/approve` | admin | Activate; the name is recorded as claimed on the list. |
| `POST /api/admin/requests/:userId/reject` `{ note? }` | admin | Mark rejected with an optional note the user sees; they may resubmit. |
| `GET /api/admin/invite-names` | admin | The list, with who claimed each name. |
| `POST /api/admin/invite-names` `{ names }` | admin | Paste names (newline / comma / 、 separated). Returns `{ added, duplicates }`. |
| `DELETE /api/admin/invite-names/:id` | admin | Remove an unclaimed name (409 if claimed). |
| `GET /api/events?scope=upcoming\|past\|mine` | profile | List with counts and the caller's own status. |
| `POST /api/events` | profile | Create. `kind: regular \| adhoc`; `repeatWeeks` > 1 creates weekly copies sharing `seriesId`. Host is auto-registered. |
| `GET /api/events/search?q=` | profile | Free text over title, games, description, location, host and participant names. Past or cancelled events only where the caller hosted or was confirmed. Upcoming first, then history. |
| `GET /api/events/:id` | profile | Detail with participants (confirmed then waitlist, in queue order). |
| `PATCH /api/events/:id` | host or admin | Edit. Raising capacity promotes from the waitlist. |
| `POST /api/events/:id/cancel` `{ reason? }` | host or admin | Cancel this occurrence. |
| `POST /api/events/:id/join` | profile | `{ status: confirmed \| waitlisted }`. |
| `POST /api/events/:id/leave` | profile | Leave; a confirmed leaver's seat goes to the first waitlisted. |
| `DELETE /api/events/:id/participants/:userId` | host or admin | Remove someone; promotes as above. |

"profile" means logged in **and** an active profile; otherwise 403 `profile_required` / `approval_pending` / `approval_rejected`, which the frontend turns into a redirect to `/onboarding` (which shows the waiting or rejected state). "admin" means the login email is in `ADMIN_EMAILS`. `GET /api/me` returns `isAdmin` and, for admins, `pendingRequests`.

### Rules

- **Membership** = the member's WeChat name (微信昵称, the name on their own profile, not the per-group nickname). On the admin's list (`/admin`) and free → in immediately; otherwise the profile is `pending` until the admin approves or rejects it on the same page. Compared after NFKC normalisation, whitespace and zero-width removal, lower-casing; emoji count. Claiming is atomic and one listed name can only be claimed once. Admins (`ADMIN_EMAILS`) skip the list. This is a friction gate against strangers, not authentication: names are not secret. Nobody is emailed about queue changes: the newcomer refreshes the waiting page, the admin sees a count in the nav.
- **Waitlist** is strict FIFO by `registrations.position`. Leaving and re-joining puts you at the back. Nobody is ever demoted when a host lowers capacity.
- **Weekly 固定局** are plain events that share a `series_id`; each week is joined and cancelled on its own. There is no series editing yet.
- **Times** are stored as ISO-8601 UTC; the frontend displays them in the browser's timezone.
- **CSRF**: session cookie is `SameSite=Lax`; every non-GET request must also carry an `Origin` (or `Referer`) equal to `APP_BASE_URL`.

## Database

`migrations/*.sql` is the single set of migrations for both databases: applied at startup on local SQLite (recorded in `schema_migrations`) and by `wrangler d1 migrations apply` on D1. `0002_magic_link.sql` is a copy of the magic-link package's migration; keep it in sync.

SQL is written in the subset SQLite, D1 and Postgres share (`$n` placeholders, `returning`, `on conflict`, window functions, ISO timestamps as text). `src/db/sqlite.ts` and `src/db/d1.ts` are the only driver-specific files behind the `Db` interface in `src/db/types.ts`.

## Deploy to Cloudflare (free)

Production runs as a Cloudflare Worker: the API and login on the Worker, data in D1 (SQLite), the built frontend as static assets. All within the free plan at a group's scale. The config is [`../wrangler.toml`](../wrangler.toml), one level up in `site/` because it spans both repos (paths in it are relative to `site/`); the entry is `src/worker.ts`. All wrangler commands run from this folder through the npm scripts, which pass `--config ../wrangler.toml`.

One-time setup (already done for `kaiju-site`, database id in wrangler.toml):

```bash
npx wrangler login
npx wrangler d1 create kaiju-site          # paste the id into ../wrangler.toml
npm run d1:migrate                         # apply migrations/ to the remote D1
npm run secret -- MAGIC_LINK_SECRET        # 48 random bytes, see .env.example
npm run secret -- MAILJET_API_KEY          # Mailjet → Account settings → API keys
npm run secret -- MAILJET_SECRET_KEY
```

Then edit `[vars]` in `../wrangler.toml` (`APP_BASE_URL`, `EMAIL_FROM`, `ADMIN_EMAILS`) and:

```bash
npm run deploy      # builds ../frontend, uploads assets + Worker
```

Login mail goes through **Mailjet** (free: 6,000 / month, 200 / day) when `MAILJET_API_KEY` and `MAILJET_SECRET_KEY` are set; `EMAIL_FROM` must be a sender address validated in Mailjet (a single address can be validated without owning a domain; SPF/DKIM on a domain improves deliverability). Resend is supported too (`RESEND_API_KEY`). With neither set the Worker prints login emails to its log; read the code with `npx wrangler tail` while testing. Later schema changes: add `migrations/000N_*.sql`, run `npm run d1:migrate`, deploy.

### Staging

`https://staging.juer.now` is a second Worker (`kaiju-site-staging`) with its own D1 database, deployed from the same code via the `[env.staging]` section of `../wrangler.toml`. Use it to try changes before `npm run deploy`:

```bash
npm run deploy:staging            # build + deploy to staging
npm run d1:migrate:staging        # apply new migrations to the staging D1 first
npm run secret:staging -- NAME    # secrets are per Worker; MAGIC_LINK_SECRET is set, Mailjet keys are not
npm run tail:staging              # live logs (login codes while no mail provider is configured)
```

Local Worker run (workerd + a local D1 file; secrets and overrides come from `../.dev.vars`, next to the config):

```bash
cp ../.dev.vars.example ../.dev.vars
npm --prefix ../frontend run build
npm run d1:migrate:local
npm run dev:worker                  # http://localhost:8790
```

Notes for the Worker runtime: the magic-link package's in-memory rate limiter is per isolate (fine for one group; back it with KV if that ever matters), and D1 has no interactive transactions, which is why every write in `services/events.ts` is a single statement or an atomic `batch`.

## Deploy as a single Node process (alternative)

```bash
cd ../frontend && npm run build           # → ../frontend/dist
cd ../backend
NODE_ENV=production STATIC_DIR=../frontend/dist APP_BASE_URL=https://your.domain   MAGIC_LINK_SECRET=… EMAIL_FROM=… MAILJET_API_KEY=… MAILJET_SECRET_KEY=… ADMIN_EMAILS=… TRUST_PROXY=1 npm start
```

Same code, SQLite file in `data/`; put it behind any HTTPS reverse proxy and back the file up.

## End-to-end test hook

`E2E_MAILBOX=1` (never in production; config throws) keeps login emails in memory, exposes the newest per address at `GET /api/_test/mail?to=…` (`code`, `link`) and turns login rate limits off. `../qa` starts the backend this way; nothing else should.

## Not in the MVP (deliberately)

Host approval of sign-ups, email notifications on promotion / cancellation, min-size auto-cancel, check-in and no-show records, blocking, series-wide edits, admin pages. The data model leaves room for all of them (see plan §4.3–4.4, appendix A).

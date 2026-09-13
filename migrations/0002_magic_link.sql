-- Copied from magic-link/migrations/0001_magic_link.sql so one migrations
-- folder serves both local SQLite and Cloudflare D1 (wrangler d1 migrations).
-- Keep in sync with the magic-link package.

-- Magic link login: pending tokens and sessions.
-- The users table belongs to the app (plan §5.3); PgUserStore expects at least:
--   users(id uuid primary key, email text unique, created_at timestamptz,
--         last_login_at timestamptz, status text default 'active')

create table if not exists auth_tokens (
  id                 uuid primary key,
  email              text        not null,
  token_hash         text        not null unique,
  code_hash          text        not null,
  created_at         timestamptz not null,
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  code_attempts      integer     not null default 0,
  request_ip         text,
  request_user_agent text
);

-- Code verification looks up "newest unconsumed token for this email".
create index if not exists auth_tokens_email_active_idx
  on auth_tokens (email, created_at desc)
  where consumed_at is null;

create index if not exists auth_tokens_expires_at_idx on auth_tokens (expires_at);

create table if not exists sessions (
  id           uuid primary key,
  user_id      uuid        not null references users (id) on delete cascade,
  token_hash   text        not null unique,
  created_at   timestamptz not null,
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);

create index if not exists sessions_user_id_idx    on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

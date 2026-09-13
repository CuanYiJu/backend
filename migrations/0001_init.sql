-- 开局 桌游群 MVP. Written in the SQL subset SQLite and Postgres share:
-- uuid / timestamptz are stored as text in SQLite and ignored as type names.
-- The magic-link package adds auth_tokens and sessions (its own migration).

create table if not exists users (
  id            uuid primary key,
  email         text        not null unique,
  created_at    timestamptz not null,
  last_login_at timestamptz,
  status        text        not null default 'active'
);

-- One per user, created on /onboarding with the group's invitation code.
create table if not exists profiles (
  user_id     uuid primary key references users (id) on delete cascade,
  nickname    text        not null,
  wechat_name text,
  bio         text,
  invite_code text        not null,
  created_at  timestamptz not null,
  updated_at  timestamptz not null
);

-- A 局: a game night (kind = regular, weekly occurrences share series_id)
-- or an ad-hoc play request (kind = adhoc).
create table if not exists events (
  id            uuid primary key,
  host_id       uuid        not null references users (id),
  series_id     uuid,
  kind          text        not null,
  title         text        not null,
  games         text,
  description   text,
  location      text        not null,
  starts_at     timestamptz not null,
  duration_min  integer     not null,
  capacity      integer     not null,
  min_size      integer     not null,
  status        text        not null default 'open',
  cancel_reason text,
  created_at    timestamptz not null,
  updated_at    timestamptz not null
);

create index if not exists events_starts_at_idx on events (starts_at);
create index if not exists events_host_id_idx on events (host_id);

-- One row per (event, user). position is the queue order within the event
-- (1 = host); re-joining after leaving assigns a new position at the back.
create table if not exists registrations (
  id         uuid primary key,
  event_id   uuid        not null references events (id) on delete cascade,
  user_id    uuid        not null references users (id) on delete cascade,
  status     text        not null,
  position   integer     not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (event_id, user_id)
);

create index if not exists registrations_event_status_idx on registrations (event_id, status, position);
create index if not exists registrations_user_idx on registrations (user_id);

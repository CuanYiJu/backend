-- Membership check: the admin pastes the group members' WeChat names; a
-- new user must type their own WeChat name and it must match an unclaimed
-- entry. Claiming stores who took it so one name cannot be used twice.
create table if not exists invite_names (
  id         uuid primary key,
  name       text        not null,
  normalized text        not null unique,
  added_by   uuid        references users (id),
  created_at timestamptz not null,
  claimed_by uuid        references users (id),
  claimed_at timestamptz
);

create index if not exists invite_names_claimed_by_idx on invite_names (claimed_by);

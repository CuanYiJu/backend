-- Approval queue: a newcomer whose WeChat name is not on the list can still
-- submit a profile; it waits as 'pending' until an admin approves it.
alter table profiles add column status text not null default 'active';
alter table profiles add column review_note text;

create index if not exists profiles_status_idx on profiles (status);

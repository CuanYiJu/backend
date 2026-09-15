-- Membership by 打招呼: newcomers introduce themselves and the admin reviews
-- every application. The WeChat-name allowlist is gone.
alter table profiles add column greeting text;

drop table if exists invite_names;

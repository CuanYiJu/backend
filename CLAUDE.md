# backend — agent notes

This repo is one third of the 开局 site. The whole-site guide, conventions and skills live one level up in the `site` deploy repo:

@../CLAUDE.md

Skills (read by path when Claude was started here rather than in `site/`): `../.claude/skills/site-dev`, `site-feature`, `site-deploy`, `site-debug`, `site-review` (each has a `SKILL.md`).

## Repo-specific
- `src/server.ts` (Node entry) and `src/worker.ts` (Cloudflare entry) share `src/app.ts`; keep `app.ts`, `routes/`, `services/`, `db/d1.ts`, `db/types.ts` free of `node:*` imports.
- `src/magic-link.ts` is the only file that knows where the login package is.
- `migrations/0002_magic_link.sql` is a copy of the package's migration; if the package changes its schema, copy it here as a new numbered migration.
- Tests: `npm run check`; helpers in `test/helpers.ts` (`testApp()`, `login()`, `admin()`, `member()`, `expectJson()`).
- Deploy config is `../wrangler.toml`; every npm script that touches wrangler passes `--config ../wrangler.toml` — keep that when adding scripts.

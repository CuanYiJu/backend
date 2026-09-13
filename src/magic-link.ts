/**
 * Single import point for the magic-link package. It lives two directories
 * up from this repo (src/magic-link next to src/site), as its README assumes:
 *
 *   src/
 *   ├── magic-link/     ← passwordless login package (own repo)
 *   └── site/
 *       ├── backend/    ← this repo
 *       └── frontend/
 *
 * Change this one path if the layout ever moves.
 */
export * from '../../../magic-link/src/index.ts';

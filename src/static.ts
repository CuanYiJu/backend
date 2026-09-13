import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function fileAt(root: string, urlPath: string): string | null {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null; // path traversal
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * Serve the built frontend (Vite `dist/`) from the API process in
 * production: one origin, one deploy. Hashed assets cache for a year;
 * everything else falls back to index.html for the SPA router.
 */
export function serveStaticSite(app: Hono, dir: string): void {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  app.get('*', (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/auth/')) return c.notFound();
    const file = fileAt(root, path) ?? (extname(path) ? null : index);
    if (!file) return c.notFound();
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const cache = file !== index && path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': cache } });
  });
}

import { resolveConfig, type MagicLinkConfig } from './magic-link.ts';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  /** SQLite file path, or ":memory:". Node only. */
  databaseFile: string;
  /** Lower-cased emails of group admins: they bypass the name list and manage it. */
  adminEmails: string[];
  trustProxy: boolean;
  /** Directory with the built frontend to serve, or null. Node only. */
  staticDir: string | null;
  mailjet: { apiKey: string; secretKey: string } | null;
  resendApiKey: string | null;
  magicLink: MagicLinkConfig;
  /** Warnings about dev-only defaults that were applied. */
  warnings: string[];
}

const DEV_SECRET = 'dev-only-secret-do-not-use-in-production-0123456789';

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  const warnings: string[] = [];

  const optional = (name: string, devDefault: string): string => {
    const v = env[name];
    if (v) return v;
    if (production) throw new Error(`config: missing environment variable ${name}`);
    warnings.push(`${name} not set, using dev default "${devDefault}"`);
    return devDefault;
  };

  const adminEmails = optional('ADMIN_EMAILS', 'admin@example.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (adminEmails.length === 0) throw new Error('config: ADMIN_EMAILS must contain at least one address');

  const magicLink = resolveConfig({
    secret: optional('MAGIC_LINK_SECRET', DEV_SECRET),
    baseUrl: optional('APP_BASE_URL', 'http://localhost:5173'),
    emailFrom: optional('EMAIL_FROM', '开局 <login@localhost>'),
    appName: env.APP_NAME ?? '开局',
    ...(env.SESSION_COOKIE_NAME ? { cookieName: env.SESSION_COOKIE_NAME } : {}),
  });

  const mailjet = env.MAILJET_API_KEY && env.MAILJET_SECRET_KEY ? { apiKey: env.MAILJET_API_KEY, secretKey: env.MAILJET_SECRET_KEY } : null;
  if ((env.MAILJET_API_KEY || env.MAILJET_SECRET_KEY) && !mailjet) {
    throw new Error('config: MAILJET_API_KEY and MAILJET_SECRET_KEY must both be set');
  }

  return {
    nodeEnv,
    port: Number(env.PORT ?? 8787),
    databaseFile: env.DATABASE_FILE ?? './data/kaiju.sqlite',
    adminEmails,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    staticDir: env.STATIC_DIR || null,
    mailjet,
    resendApiKey: env.RESEND_API_KEY || null,
    magicLink,
    warnings,
  };
}

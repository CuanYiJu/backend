import {
  ConsoleMailer,
  MagicLinkService,
  MemoryRateLimiter,
  PgSessionStore,
  PgTokenStore,
  PgUserStore,
  ResendMailer,
  createHandlers,
  type Mailer,
  type MagicLinkHandlers,
  type SqlClient,
} from './magic-link.ts';
import type { AppConfig } from './config.ts';
import { MailjetMailer } from './mailers/mailjet.ts';

export interface Auth {
  service: MagicLinkService;
  handlers: MagicLinkHandlers;
}

export interface AuthOptions {
  /** Override the mailer (tests capture the email instead of printing it). */
  mailer?: Mailer;
}

/** Mailjet when its keys are set, else Resend, else print to the log. */
export function selectMailer(config: AppConfig): Mailer {
  if (config.mailjet) return new MailjetMailer(config.mailjet);
  if (config.resendApiKey) return new ResendMailer({ apiKey: config.resendApiKey });
  return new ConsoleMailer();
}

/**
 * Wire the magic-link package to our database. Its Postgres stores run
 * unchanged on SQLite and D1 through the Db adapters: `$n` placeholders,
 * RETURNING, partial indexes and ON CONFLICT all exist in both.
 */
export function createAuth(config: AppConfig, db: SqlClient, options: AuthOptions = {}): Auth {
  const service = new MagicLinkService({
    config: config.magicLink,
    tokens: new PgTokenStore(db),
    sessions: new PgSessionStore(db),
    users: new PgUserStore(db),
    mailer: options.mailer ?? selectMailer(config),
    rateLimiter: new MemoryRateLimiter(),
  });
  const handlers = createHandlers(service, { trustProxy: config.trustProxy });
  return { service, handlers };
}

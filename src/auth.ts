import {
  ConsoleMailer,
  MagicLinkService,
  MemoryRateLimiter,
  PgSessionStore,
  PgTokenStore,
  PgUserStore,
  ResendMailer,
  createHandlers,
  unlimited,
  type EmailMessage,
  type Mailer,
  type MagicLinkHandlers,
  type SqlClient,
} from './magic-link.ts';
import type { AppConfig } from './config.ts';
import { MailjetMailer } from './mailers/mailjet.ts';
import { MailboxMailer } from './mailers/mailbox.ts';

export interface Auth {
  service: MagicLinkService;
  handlers: MagicLinkHandlers;
  /** Set when E2E_MAILBOX is on: tests read login codes from it. */
  mailbox: MailboxMailer | null;
}

export interface AuthOptions {
  /** Override the mailer (tests capture the email instead of printing it). */
  mailer?: Mailer;
}

/**
 * Logs every failed send with the provider's own error text before
 * rethrowing, so `wrangler tail` / Workers Logs show *why* login mail
 * bounced instead of only the generic 503 the user sees.
 */
export class LoggingMailer implements Mailer {
  readonly provider: string;
  private readonly inner: Mailer;

  constructor(provider: string, inner: Mailer) {
    this.provider = provider;
    this.inner = inner;
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.inner.send(message);
    } catch (err) {
      console.error(`[mail:${this.provider}] send to ${message.to} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}

/** E2E mailbox when enabled; else Mailjet when its keys are set, else Resend, else print to the log. */
export function selectMailer(config: AppConfig): Mailer {
  if (config.e2eMailbox) return new MailboxMailer();
  if (config.mailjet) return new LoggingMailer('mailjet', new MailjetMailer(config.mailjet));
  if (config.resendApiKey) return new LoggingMailer('resend', new ResendMailer({ apiKey: config.resendApiKey }));
  return new ConsoleMailer();
}

/**
 * Wire the magic-link package to our database. Its Postgres stores run
 * unchanged on SQLite and D1 through the Db adapters: `$n` placeholders,
 * RETURNING, partial indexes and ON CONFLICT all exist in both.
 */
export function createAuth(config: AppConfig, db: SqlClient, options: AuthOptions = {}): Auth {
  const mailer = options.mailer ?? selectMailer(config);
  const service = new MagicLinkService({
    config: config.magicLink,
    tokens: new PgTokenStore(db),
    sessions: new PgSessionStore(db),
    users: new PgUserStore(db),
    mailer,
    // Rate limits would make a test run of dozens of logins from one IP fail.
    rateLimiter: config.e2eMailbox ? unlimited : new MemoryRateLimiter(),
  });
  const handlers = createHandlers(service, { trustProxy: config.trustProxy });
  return { service, handlers, mailbox: mailer instanceof MailboxMailer ? mailer : null };
}

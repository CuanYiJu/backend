import type { EmailMessage, Mailer } from '../magic-link.ts';

export interface MailboxEntry {
  to: string;
  subject: string;
  /** The 6-digit login code, parsed from the subject. */
  code: string | null;
  /** The magic link, parsed from the text body. */
  link: string | null;
  text: string;
  receivedAt: string;
}

/**
 * Test-only mailer: keeps the last messages in memory so end-to-end tests
 * can read login codes through `GET /api/_test/mail?to=…` instead of a real
 * inbox. Enabled by `E2E_MAILBOX=1`; config refuses it in production.
 */
export class MailboxMailer implements Mailer {
  private readonly entries: MailboxEntry[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  async send(message: EmailMessage): Promise<void> {
    this.entries.push({
      to: message.to.toLowerCase(),
      subject: message.subject,
      code: /(\d{6})/.exec(message.subject)?.[1] ?? null,
      link: /https?:\/\/\S+\/auth\/verify\?token=[A-Za-z0-9_-]+/.exec(message.text)?.[0] ?? null,
      text: message.text,
      receivedAt: new Date().toISOString(),
    });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  /** Newest message for the address, or null. */
  latest(to: string): MailboxEntry | null {
    const key = to.toLowerCase();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && e.to === key) return e;
    }
    return null;
  }

  get size(): number {
    return this.entries.length;
  }
}

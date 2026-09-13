import type { EmailMessage, Mailer } from '../magic-link.ts';

export interface MailjetMailerOptions {
  apiKey: string;
  secretKey: string;
  /** Override for tests. */
  fetch?: typeof fetch;
  endpoint?: string;
}

interface MailjetResponse {
  Messages?: { Status?: string; Errors?: { ErrorMessage?: string }[] }[];
}

/**
 * Mailjet Send API v3.1 (free plan: 6,000 emails / month, 200 / day).
 * Same shape as the magic-link package's ResendMailer so it plugs straight
 * into MagicLinkService. Dependency-free: one fetch, Basic auth.
 * The From address must be a validated sender in Mailjet; validating a
 * single address works without owning a domain, SPF/DKIM on a domain
 * improves deliverability.
 */
export class MailjetMailer implements Mailer {
  private readonly auth: string;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;

  constructor(opts: MailjetMailerOptions) {
    if (!opts.apiKey || !opts.secretKey) throw new Error('MailjetMailer: apiKey and secretKey are required');
    this.auth = `Basic ${btoa(`${opts.apiKey}:${opts.secretKey}`)}`;
    // Never store the bare global: calling it as `this.fetchFn(...)` gives it
    // the mailer as `this`, which the Workers runtime rejects ("Illegal invocation").
    this.fetchFn = opts.fetch ?? boundFetch;
    this.endpoint = opts.endpoint ?? 'https://api.mailjet.com/v3.1/send';
  }

  async send(message: EmailMessage): Promise<void> {
    const from = parseAddress(message.from);
    const res = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Messages: [
          {
            From: from.name ? { Email: from.email, Name: from.name } : { Email: from.email },
            To: [{ Email: message.to }],
            Subject: message.subject,
            TextPart: message.text,
            HTMLPart: message.html,
          },
        ],
      }),
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`MailjetMailer: ${res.status} ${res.statusText} ${body}`.trim());
    let parsed: MailjetResponse = {};
    try {
      parsed = JSON.parse(body) as MailjetResponse;
    } catch {
      // A 200 without JSON is still a success as far as Mailjet documents it.
    }
    const first = parsed.Messages?.[0];
    if (first && first.Status !== 'success') {
      const reason = first.Errors?.map((e) => e.ErrorMessage).filter(Boolean).join('; ') || first.Status;
      throw new Error(`MailjetMailer: message rejected: ${reason}`);
    }
  }
}

/** "开局 <login@example.com>" → { name: "开局", email: "login@example.com" }; bare addresses pass through. */
export function parseAddress(value: string): { name: string | null; email: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(value);
  if (m && m[2]) return { name: m[1]?.trim() || null, email: m[2].trim() };
  return { name: null, email: value.trim() };
}

/** The global fetch with a neutral `this`, safe to keep as a field on Workers and Node alike. */
export const boundFetch: typeof fetch = (input, init) => fetch(input, init);

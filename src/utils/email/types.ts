/**
 * Email provider abstraction (Issue #80).
 *
 * Adapters implement EmailProvider and are selected at runtime by
 * `getEmailProvider(env)` in ./index.ts. Call sites use `sendEmail()`
 * and handle EmailNotConfiguredError / EmailSendError explicitly.
 */

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export class EmailNotConfiguredError extends Error {
  constructor(message = "Email delivery not configured") {
    super(message);
    this.name = "EmailNotConfiguredError";
  }
}

export class EmailSendError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmailSendError";
    this.status = status;
  }
}

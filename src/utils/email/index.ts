import type { Env } from "../../types";
import { ResendProvider } from "./resend";
import {
  type EmailMessage,
  type EmailProvider,
  EmailNotConfiguredError,
} from "./types";

export {
  type EmailMessage,
  type EmailProvider,
  EmailNotConfiguredError,
  EmailSendError,
} from "./types";

/**
 * Resolve the configured EmailProvider for this environment, or null if
 * none is configured. Selection is explicit via `EMAIL_PROVIDER` —
 * presence of provider-specific secrets alone does not enable email.
 */
export function getEmailProvider(env: Env): EmailProvider | null {
  switch (env.EMAIL_PROVIDER) {
    case "resend":
      if (!env.RESEND_API_KEY) return null;
      return new ResendProvider(env.RESEND_API_KEY);
    default:
      return null;
  }
}

/**
 * Send a transactional email via the configured provider. Throws
 * EmailNotConfiguredError when no provider is selected or its credentials
 * are missing; throws EmailSendError on provider/network failure. Call
 * sites must translate both to HTTP responses (503 / 502 respectively)
 * before any persistent state change.
 */
export async function sendEmail(env: Env, message: EmailMessage): Promise<void> {
  const provider = getEmailProvider(env);
  if (!provider) throw new EmailNotConfiguredError();
  if (!message.from) {
    throw new EmailNotConfiguredError("EMAIL_FROM is not configured");
  }
  await provider.send(message);
}

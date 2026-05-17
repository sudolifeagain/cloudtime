import { type EmailMessage, type EmailProvider, EmailSendError } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 2000;

interface ResendErrorBody {
  message?: string;
  name?: string;
}

export class ResendProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      throw new EmailSendError(`Resend request failed: ${reason}`);
    }

    if (response.ok) return;

    let detail = "";
    try {
      const body = (await response.json()) as ResendErrorBody;
      detail = body.message ?? body.name ?? "";
    } catch {
      // body wasn't JSON — fall through with empty detail
    }
    throw new EmailSendError(
      `Resend rejected request: status=${response.status}${detail ? ` detail=${detail}` : ""}`,
      response.status,
    );
  }
}

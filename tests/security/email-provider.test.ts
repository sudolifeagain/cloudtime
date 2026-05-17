/**
 * Tests for src/utils/email/* — provider selector and Resend adapter.
 * The adapter mocks globalThis.fetch to avoid real network access.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmailNotConfiguredError,
  EmailSendError,
  getEmailProvider,
  sendEmail,
} from "../../src/utils/email";
import { ResendProvider } from "../../src/utils/email/resend";
import type { Env } from "../../src/types";

function envWith(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe("getEmailProvider", () => {
  it("returns null when EMAIL_PROVIDER is unset", () => {
    expect(getEmailProvider(envWith({}))).toBeNull();
  });

  it("returns null for an unknown EMAIL_PROVIDER value", () => {
    expect(
      getEmailProvider(envWith({ EMAIL_PROVIDER: "smoke-signals" } as Partial<Env>)),
    ).toBeNull();
  });

  it("returns null when EMAIL_PROVIDER=resend but RESEND_API_KEY is missing", () => {
    expect(
      getEmailProvider(envWith({ EMAIL_PROVIDER: "resend" } as Partial<Env>)),
    ).toBeNull();
  });

  it("returns a ResendProvider when configured", () => {
    const p = getEmailProvider(
      envWith({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_xxx" } as Partial<Env>),
    );
    expect(p).toBeInstanceOf(ResendProvider);
  });
});

describe("sendEmail (selector)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws EmailNotConfiguredError when no provider is selected", async () => {
    await expect(
      sendEmail(envWith({}), {
        from: "from@example.test",
        to: "to@example.test",
        subject: "x",
        text: "x",
        html: "x",
      }),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it("throws EmailNotConfiguredError when EMAIL_FROM is empty", async () => {
    await expect(
      sendEmail(
        envWith({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_xxx" } as Partial<Env>),
        { from: "", to: "to@example.test", subject: "x", text: "x", html: "x" },
      ),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });

  it("delegates to the provider on success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));

    await sendEmail(
      envWith({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_xxx" } as Partial<Env>),
      {
        from: "noreply@example.test",
        to: "alice@example.test",
        subject: "Confirm CloudTime account link",
        text: "https://link",
        html: "<p>https://link</p>",
      },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_xxx",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: "noreply@example.test",
      to: "alice@example.test",
      subject: "Confirm CloudTime account link",
    });
  });
});

describe("ResendProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  const message = {
    from: "noreply@example.test",
    to: "alice@example.test",
    subject: "s",
    text: "t",
    html: "h",
  };

  it("succeeds when Resend returns 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    await expect(new ResendProvider("re_xxx").send(message)).resolves.toBeUndefined();
  });

  it("throws EmailSendError carrying the HTTP status on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid key" }), { status: 401 }),
    );
    const err = await new ResendProvider("re_bad")
      .send(message)
      .catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).status).toBe(401);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).toContain("invalid key");
  });

  it("throws EmailSendError when fetch itself rejects (e.g. timeout)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("AbortError: timed out"));
    const err = await new ResendProvider("re_xxx").send(message).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as Error).message).toContain("Resend request failed");
  });

  it("tolerates non-JSON error bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );
    const err = await new ResendProvider("re_xxx").send(message).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).status).toBe(503);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendEmail } from "../src/notify/email";

/**
 * The real SMTP path of `sendEmail` (no `sendImpl` injected), with nodemailer mocked: what the
 * transport is handed, that optional parts are only sent when present, that the transport is
 * always closed, and that a hung send is cut off by the per-attempt timeout. The retry/outcome
 * logic itself is covered with an injected `sendImpl` in notify.test.ts.
 */
// `vi.mock` is hoisted above the imports, so the mocks must be created in `vi.hoisted`.
const { sendMail, close, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn<(mail: Record<string, unknown>) => Promise<unknown>>();
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close }));
  return { sendMail, close, createTransport };
});

vi.mock("nodemailer", () => ({ default: { createTransport } }));

const message = { from: "ops@x.io", to: ["a@x.io", "b@x.io"], subject: "s", text: "t" };
const noSleep = () => Promise.resolve();

beforeEach(() => {
  sendMail.mockReset();
  close.mockReset();
  createTransport.mockClear();
});

describe("sendEmail — nodemailer transport", () => {
  it("joins recipients, omits absent html/attachments, and closes the transport", async () => {
    sendMail.mockResolvedValue({});
    const outcome = await sendEmail("smtp://h", message, {
      maxAttempts: 1,
      timeoutMs: 1_000,
      sleep: noSleep,
    });

    expect(outcome).toMatchObject({ ok: true, attempts: 1 });
    expect(createTransport).toHaveBeenCalledWith("smtp://h");
    expect(sendMail).toHaveBeenCalledWith({
      from: "ops@x.io",
      to: "a@x.io, b@x.io",
      subject: "s",
      text: "t",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("passes html and attachments through when the message has them", async () => {
    sendMail.mockResolvedValue({});
    const attachments = [{ filename: "r.csv", content: "a,b" }];
    await sendEmail(
      "smtp://h",
      { ...message, html: "<p>t</p>", attachments },
      { maxAttempts: 1, timeoutMs: 1_000, sleep: noSleep },
    );

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ html: "<p>t</p>", attachments }),
    );
  });

  it("cuts off a hung send at timeoutMs and still closes the transport", async () => {
    sendMail.mockReturnValue(new Promise(() => undefined));
    const outcome = await sendEmail("smtp://h", message, {
      maxAttempts: 2,
      timeoutMs: 5,
      sleep: noSleep,
    });

    expect(outcome).toMatchObject({ ok: false, attempts: 2, error: "email send timed out" });
    // One fresh transport per attempt, each closed even though sendMail never settled.
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("closes the transport when sendMail rejects", async () => {
    sendMail.mockRejectedValue(new Error("535 auth failed"));
    const outcome = await sendEmail("smtp://h", message, {
      maxAttempts: 1,
      timeoutMs: 1_000,
      sleep: noSleep,
    });

    expect(outcome).toMatchObject({ ok: false, error: "535 auth failed" });
    expect(close).toHaveBeenCalledOnce();
  });
});

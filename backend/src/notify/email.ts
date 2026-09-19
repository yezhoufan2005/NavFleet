/**
 * The email channel (Phase 16D-2a): send one message over SMTP via nodemailer, with the same
 * bounded-retry + per-attempt-timeout shape the HTTP channels use, folded into an
 * {@link AttemptOutcome} so the dispatcher records it exactly like an HTTP send.
 *
 * The SMTP connection string (which carries credentials) comes from the env var the channel names
 * — never from `notify.json`, never logged, never in a record. `httpStatus` is always null for
 * email (there is no HTTP status); success/failure and the error summary carry the outcome.
 *
 * `sendImpl` is injectable so unit tests exercise the retry/timeout/outcome logic without a real
 * SMTP server or the nodemailer dependency; production omits it and a real transport is built per
 * call (transports are cheap, and a per-alert send is rare).
 */
import nodemailer from "nodemailer";
import type { AttemptOutcome } from "./retry";

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

export interface EmailSendOptions {
  maxAttempts: number;
  timeoutMs: number;
  /** Injectable for tests; production omits it and a real nodemailer transport is used. */
  sendImpl?: (smtpUrl: string, message: EmailMessage, timeoutMs: number) => Promise<void>;
  /** Injectable delay; tests pass a no-op to skip real waits. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real send: build a transport from the SMTP URL and sendMail, bounding the attempt with a manual
 * timeout race (the URL form of `createTransport` takes no per-call timeout options, so the socket
 * timeouts are enforced here and the transport is always closed afterwards).
 */
const nodemailerSend = async (
  smtpUrl: string,
  message: EmailMessage,
  timeoutMs: number,
): Promise<void> => {
  const transport = nodemailer.createTransport(smtpUrl);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      transport.sendMail({
        from: message.from,
        to: message.to.join(", "),
        subject: message.subject,
        text: message.text,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("email send timed out")), timeoutMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    transport.close();
  }
};

const summarize = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

/**
 * Send `message` over SMTP, retrying a failure (all SMTP failures are treated as retryable —
 * they are almost always transient connection issues) up to `maxAttempts` with linear backoff.
 * Never throws: every failure mode is folded into the returned outcome.
 */
export const sendEmail = async (
  smtpUrl: string,
  message: EmailMessage,
  options: EmailSendOptions,
): Promise<AttemptOutcome> => {
  const sendImpl = options.sendImpl ?? nodemailerSend;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts);

  let attempts = 0;
  let latencyMs = 0;
  let error: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const startedAt = Date.now();
    try {
      await sendImpl(smtpUrl, message, options.timeoutMs);
      latencyMs = Date.now() - startedAt;
      return { ok: true, httpStatus: null, attempts, latencyMs, error: null };
    } catch (thrown) {
      latencyMs = Date.now() - startedAt;
      error = summarize(thrown);
    }
    if (attempt < maxAttempts) {
      await sleep(attempt * 200);
    }
  }

  return { ok: false, httpStatus: null, attempts, latencyMs, error };
};

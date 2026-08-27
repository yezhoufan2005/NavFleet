import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { logger } from "./logger";

declare module "express-serve-static-core" {
  interface Request {
    /** Correlation id for this request: inbound `X-Request-Id`, or generated. */
    requestId?: string;
    /** Logger pre-bound to `requestId` — use it for any per-request logging. */
    log?: Logger;
  }
}

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Accept a caller-supplied correlation id only if it is short and made of safe
 * characters. An arbitrary header value would otherwise flow into every log line
 * and into a response header — an easy vector for log forging (CR/LF), log
 * bloat, or header smuggling. Duplicate headers arrive as an array and are
 * rejected outright rather than silently joined.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~:-]{1,128}$/;

export const normalizeRequestId = (value: unknown): string | null =>
  typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : null;

/**
 * Assign every request a correlation id, expose it as `X-Request-Id` on the
 * response, and attach a logger bound to it. An upstream id (nginx, a probe, a
 * calling service) is preserved when trustworthy so one id spans the whole hop
 * chain; otherwise a UUID is minted here.
 */
export const requestContext = (request: Request, response: Response, next: NextFunction): void => {
  const requestId = normalizeRequestId(request.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  request.requestId = requestId;
  request.log = logger.child({ requestId });
  response.setHeader("X-Request-Id", requestId);
  next();
};

/** The request-bound logger, falling back to the root logger outside a request. */
export const requestLogger = (request: Request): Logger => request.log ?? logger;

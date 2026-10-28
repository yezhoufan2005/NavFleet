import type express from "express";
import type { ZodError } from "zod";

/** Uniform 400 response for zod validation failures across the API. */
export const respondValidationError = (response: express.Response, error: ZodError): void => {
  response.status(400).json({
    error: "invalid_request",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
};

/**
 * Run a config file's parser over a request body before anything touches disk. A parser throws
 * with the reason (which field, which reference); that becomes a 400 `{ error: code, detail }` and
 * the result is `undefined`, so the caller returns. Every whole-file write route started with the
 * same eight lines of try/catch to say this.
 */
export const parseOrRespond = <T>(
  response: express.Response,
  code: string,
  parse: () => T,
): T | undefined => {
  try {
    return parse();
  } catch (error) {
    response.status(400).json({
      error: code,
      detail: error instanceof Error ? error.message : code,
    });
    return undefined;
  }
};

/**
 * Builds the uniform responder for a service-layer refusal: it maps a stable error code to an HTTP
 * status via the caller's table and echoes the code in the body. Each router supplies its own
 * code→status table (`AdminActionError`, `RbacError`, …) and gets back a 2-arg `(response, error)`
 * responder, so the shaping logic lives in one place while the tables stay route-local.
 */
export const makeActionErrorResponder =
  <E extends string>(statusByError: Record<E, number>) =>
  (response: express.Response, error: E): void => {
    response.status(statusByError[error]).json({ error });
  };

/**
 * Optimistic concurrency for whole-file config writes.
 *
 * A config GET sends the file's version as an `ETag`; an editor that saves sends it back as
 * `If-Match`. If the file changed in between (another admin saved, or it was hand-edited) the write
 * is refused with 409 `config_conflict` and nothing is written, so a change made elsewhere is never
 * silently overwritten. A write without `If-Match` (scripts, older clients) is accepted as before.
 */
export const sendConfigVersion = (response: express.Response, version: string): void => {
  response.setHeader("ETag", `"${version}"`);
};

/** The version an `If-Match` header names, or undefined when there is none (or it is `*`). */
export const expectedConfigVersion = (request: express.Request): string | undefined => {
  const header = request.get("If-Match");
  if (!header || header.trim() === "*") return undefined;
  return header.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
};

/**
 * Lists are capped server-side (newest first). Say so when a result hit the cap, so a client can
 * tell "these are all of them" from "there are more — narrow the window": `truncated` in the body,
 * and the same as an `X-Result-Truncated` header for clients that only read the array.
 */
export const markTruncation = (
  response: express.Response,
  count: number,
  limit: number,
): { truncated: boolean; limit: number } => {
  const truncated = count >= limit;
  if (truncated) response.setHeader("X-Result-Truncated", "true");
  return { truncated, limit };
};

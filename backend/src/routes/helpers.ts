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

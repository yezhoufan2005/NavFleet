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

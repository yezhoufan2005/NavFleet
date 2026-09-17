import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { createAuthenticate, requireRole, type UserLookup } from "../src/auth/middleware";
import { signAccessToken } from "../src/auth/tokens";
import type { UserRecord } from "../src/types";

const mockResponse = () => {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res as Response;
  });
  return res as Response & { statusCode?: number; body?: unknown };
};

/** Let the middleware's `lookupUser().then(...)` chain settle before asserting. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const storedUser = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  username: "bob",
  passwordHash: "x",
  role: "viewer",
  createdAt: "t",
  updatedAt: "t",
  enabled: true,
  tokenVersion: 0,
  displayName: "bob",
  email: null,
  phone: null,
  lastLoginAt: null,
  passwordUpdatedAt: "t",
  ...overrides,
});

const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

const lookupReturning = (user: UserRecord | null): UserLookup => vi.fn(() => Promise.resolve(user));

describe("createAuthenticate", () => {
  it("rejects requests without a token (401) and never looks up a user", async () => {
    const lookup = lookupReturning(storedUser());
    const req = { cookies: {}, headers: {} } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn();
    createAuthenticate(lookup)(req, res, next);
    await flush();
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("accepts a valid token whose version matches an enabled user", async () => {
    const token = signAccessToken({ username: "bob", role: "viewer" }, 0);
    const res = mockResponse();
    const next = vi.fn();
    createAuthenticate(lookupReturning(storedUser()))(bearer(token), res, next);
    await flush();
    expect(next).toHaveBeenCalledOnce();
  });

  it("attaches the role from the token, not the looked-up user (role change is 15C)", async () => {
    const token = signAccessToken({ username: "bob", role: "operator" }, 0);
    const req = bearer(token);
    const next = vi.fn();
    // Stored user says viewer; the signed token says operator. Until a version bump, the
    // token wins — the lookup only gates revocation.
    createAuthenticate(lookupReturning(storedUser({ role: "viewer" })))(req, mockResponse(), next);
    await flush();
    expect(req.user).toMatchObject({ username: "bob", role: "operator" });
  });

  it("401s when the user no longer exists", async () => {
    const token = signAccessToken({ username: "bob", role: "viewer" }, 0);
    const res = mockResponse();
    const next = vi.fn();
    createAuthenticate(lookupReturning(null))(bearer(token), res, next);
    await flush();
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the account is disabled", async () => {
    const token = signAccessToken({ username: "bob", role: "viewer" }, 0);
    const res = mockResponse();
    const next = vi.fn();
    createAuthenticate(lookupReturning(storedUser({ enabled: false })))(bearer(token), res, next);
    await flush();
    expect(res.statusCode).toBe(401);
  });

  it("401s when the token version is stale (logout / password change happened)", async () => {
    const token = signAccessToken({ username: "bob", role: "viewer" }, 0);
    const res = mockResponse();
    const next = vi.fn();
    createAuthenticate(lookupReturning(storedUser({ tokenVersion: 1 })))(bearer(token), res, next);
    await flush();
    expect(res.statusCode).toBe(401);
  });
});

describe("requireRole", () => {
  it("calls next when the role is permitted", () => {
    const req = { user: { username: "a", role: "admin" } } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn();
    requireRole("admin")(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 403 when the role is not permitted", () => {
    const req = { user: { username: "a", role: "viewer" } } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn();
    requireRole("admin")(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no user", () => {
    const req = {} as unknown as Request;
    const res = mockResponse();
    const next = vi.fn();
    requireRole("viewer")(req, res, next);
    expect(res.statusCode).toBe(401);
  });
});

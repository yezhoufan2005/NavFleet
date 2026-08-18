import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { authenticate, requireRole } from "../src/auth/middleware";
import { signAccessToken } from "../src/auth/tokens";

const mockResponse = () => {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response["status"];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res as Response;
  }) as unknown as Response["json"];
  return res as Response & { statusCode?: number; body?: unknown };
};

describe("authenticate", () => {
  it("rejects requests without a token (401)", () => {
    const req = { cookies: {}, headers: {} } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts a valid bearer access token and attaches the user", () => {
    const token = signAccessToken({ username: "bob", role: "viewer" });
    const req = {
      cookies: {},
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ username: "bob", role: "viewer" });
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

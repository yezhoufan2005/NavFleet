import { describe, it, expect } from "vitest";
import { signAccessToken, signRefreshToken, verifyToken } from "../src/auth/tokens";

const user = { username: "alice", role: "operator" as const };

describe("tokens", () => {
  it("signs and verifies an access token roundtrip", () => {
    const claims = verifyToken(signAccessToken(user), "access");
    expect(claims).toMatchObject({ sub: "alice", role: "operator", type: "access" });
  });

  it("signs and verifies a refresh token roundtrip", () => {
    const claims = verifyToken(signRefreshToken(user), "refresh");
    expect(claims).toMatchObject({ sub: "alice", role: "operator", type: "refresh" });
  });

  it("rejects an access token when a refresh token is expected", () => {
    expect(verifyToken(signAccessToken(user), "refresh")).toBeNull();
  });

  it("rejects a tampered or malformed token", () => {
    expect(verifyToken("not.a.jwt", "access")).toBeNull();
    expect(verifyToken(signAccessToken(user) + "x", "access")).toBeNull();
  });
});

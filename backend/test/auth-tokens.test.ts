import { describe, it, expect } from "vitest";
import { signAccessToken, signRefreshToken, verifyToken } from "../src/auth/tokens";

const user = { username: "alice", role: "operator" as const };

describe("tokens", () => {
  it("signs and verifies an access token roundtrip", () => {
    const claims = verifyToken(signAccessToken(user, 0), "access");
    expect(claims).toMatchObject({ sub: "alice", role: "operator", type: "access", ver: 0 });
  });

  it("signs and verifies a refresh token roundtrip", () => {
    const claims = verifyToken(signRefreshToken(user, 3), "refresh");
    expect(claims).toMatchObject({ sub: "alice", role: "operator", type: "refresh", ver: 3 });
  });

  it("carries the token version so a stale token can be detected", () => {
    expect(verifyToken(signAccessToken(user, 7), "access")?.ver).toBe(7);
  });

  it("honours a refresh-TTL override so a kiosk token outlives a normal one (Phase 17C)", () => {
    // verifyToken maps to domain claims and drops `exp`, so read the raw payload's exp directly.
    const expOf = (token: string): number => {
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
        exp: number;
      };
      return payload.exp;
    };
    const short = expOf(signRefreshToken(user, 0, "sid", "1s"));
    const long = expOf(signRefreshToken(user, 0, "sid", "180d"));
    expect(long - short).toBeGreaterThan(179 * 24 * 3600);
  });

  it("rejects an access token when a refresh token is expected", () => {
    expect(verifyToken(signAccessToken(user, 0), "refresh")).toBeNull();
  });

  it("rejects a tampered or malformed token", () => {
    expect(verifyToken("not.a.jwt", "access")).toBeNull();
    expect(verifyToken(signAccessToken(user, 0) + "x", "access")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  CAPABILITIES,
  capabilitiesForRole,
  resolveEffectiveCapabilities,
  type RbacGroup,
  type RbacRole,
} from "../src/index";

const AT = "2026-10-01T00:00:00.000Z";
const role = (
  id: string,
  capabilities: RbacRole["capabilities"],
): RbacRole => ({
  id,
  name: id,
  capabilities,
  createdAt: AT,
  updatedAt: AT,
});
const group = (roleIds: string[], memberUsernames: string[]): RbacGroup => ({
  id: "g",
  name: "g",
  description: "",
  roleIds,
  memberUsernames,
  createdAt: AT,
  updatedAt: AT,
});

describe("built-in role presets", () => {
  it("gives admin everything, operator acknowledgement, viewer nothing", () => {
    expect(capabilitiesForRole("admin")).toEqual(CAPABILITIES);
    expect(capabilitiesForRole("operator")).toEqual(["alerts:ack"]);
    expect(capabilitiesForRole("viewer")).toEqual([]);
  });

  it("falls back to no capability for a role it does not know", () => {
    expect(capabilitiesForRole("root" as never)).toEqual([]);
  });
});

describe("resolveEffectiveCapabilities", () => {
  const roles = [
    role("codebook", ["codebook:write"]),
    role("scenes", ["scenes:write"]),
  ];

  it("adds what the user's groups grant on top of the base role, in catalogue order", () => {
    const caps = resolveEffectiveCapabilities(
      { username: "zhaoyun", role: "operator" },
      roles,
      [group(["scenes", "codebook"], ["zhaoyun"])],
    );
    expect(caps).toEqual(
      CAPABILITIES.filter((c) =>
        ["alerts:ack", "codebook:write", "scenes:write"].includes(c),
      ),
    );
  });

  it("grants nothing from a group the user is not in, or from a role that no longer exists", () => {
    const caps = resolveEffectiveCapabilities(
      { username: "zhaoyun", role: "viewer" },
      roles,
      [
        group(["codebook"], ["someone-else"]),
        group(["deleted-role"], ["zhaoyun"]),
      ],
    );
    expect(caps).toEqual([]);
  });

  it("never lifts a kiosk account above its base role, whatever group it is put in", () => {
    const caps = resolveEffectiveCapabilities(
      { username: "wall", role: "viewer", kiosk: true },
      roles,
      [group(["codebook", "scenes"], ["wall"])],
    );
    expect(caps).toEqual([]);
  });

  it("lets whoever may write the outbound config also read it", () => {
    const caps = resolveEffectiveCapabilities(
      { username: "zhaoyun", role: "viewer" },
      [role("notify-editor", ["notify:write"])],
      [group(["notify-editor"], ["zhaoyun"])],
    );
    expect(caps).toEqual(["notify:read", "notify:write"]);
  });
});

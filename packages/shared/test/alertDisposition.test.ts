import { describe, it, expect } from "vitest";
import {
  ALERT_DISPOSITIONS,
  ALERT_CLOSE_DISPOSITIONS,
  ALERT_DISPOSITION_LABELS,
  ALERT_CLOSE_DISPOSITION_LABELS,
  alertDisposition,
  alertCloseDisposition,
  canClaim,
  canRelease,
  canIgnore,
  canUnignore,
  type DispositionState,
} from "../src/alertDisposition";

/** A firing, untouched message; override fields per case. */
const state = (over: Partial<DispositionState> = {}): DispositionState => ({
  active: true,
  ...over,
});

describe("alertDisposition — derived handling state", () => {
  it("is unhandled when nothing is set", () => {
    expect(alertDisposition({})).toBe("unhandled");
  });

  it("is investigating when claimed", () => {
    expect(alertDisposition({ claimedBy: "zhaoyun" })).toBe("investigating");
  });

  it("is ignored when ignored, even if a claim also lingers", () => {
    expect(
      alertDisposition({ claimedBy: "zhaoyun", ignoredBy: "qianwei" }),
    ).toBe("ignored");
  });

  it("labels every state", () => {
    for (const d of ALERT_DISPOSITIONS) {
      expect(ALERT_DISPOSITION_LABELS[d]).toBeTruthy();
    }
  });
});

describe("alertCloseDisposition — how it closed", () => {
  it("is null while still firing (not closed yet)", () => {
    expect(alertCloseDisposition(state({ claimedBy: "zhaoyun" }))).toBeNull();
  });

  it("auto-recovered when it cleared untouched", () => {
    expect(alertCloseDisposition({ active: false })).toBe("auto_recovered");
  });

  it("resolved-after-handling when it cleared while claimed", () => {
    expect(alertCloseDisposition({ active: false, claimedBy: "zhaoyun" })).toBe(
      "resolved_after_handling",
    );
  });

  it("cleared-after-ignore when it cleared while ignored", () => {
    expect(
      alertCloseDisposition({
        active: false,
        claimedBy: "zhaoyun",
        ignoredBy: "qianwei",
      }),
    ).toBe("cleared_after_ignore");
  });

  it("labels every close disposition", () => {
    for (const c of ALERT_CLOSE_DISPOSITIONS) {
      expect(ALERT_CLOSE_DISPOSITION_LABELS[c]).toBeTruthy();
    }
  });
});

describe("transition guards", () => {
  it("claim: only from firing + unhandled", () => {
    expect(canClaim(state())).toBeNull();
    expect(canClaim(state({ active: false }))).toBe("not_active");
    expect(canClaim(state({ claimedBy: "zhaoyun" }))).toBe("already_claimed");
    expect(canClaim(state({ ignoredBy: "qianwei" }))).toBe("already_ignored");
  });

  it("release: claimant or admin, only while investigating", () => {
    const claimed = state({ claimedBy: "zhaoyun" });
    expect(canRelease(claimed, "zhaoyun")).toBeNull();
    expect(canRelease(claimed, "qianwei")).toBe("not_claimant");
    expect(canRelease(claimed, "qianwei", true)).toBeNull();
    expect(canRelease(state(), "zhaoyun")).toBe("not_investigating");
    expect(
      canRelease(state({ active: false, claimedBy: "zhaoyun" }), "zhaoyun"),
    ).toBe("not_active");
  });

  it("ignore: from firing unless already ignored; a claim does not block it", () => {
    expect(canIgnore(state())).toBeNull();
    expect(canIgnore(state({ claimedBy: "zhaoyun" }))).toBeNull();
    expect(canIgnore(state({ ignoredBy: "qianwei" }))).toBe("already_ignored");
    expect(canIgnore(state({ active: false }))).toBe("not_active");
  });

  it("unignore: only while firing + ignored", () => {
    expect(canUnignore(state({ ignoredBy: "qianwei" }))).toBeNull();
    expect(canUnignore(state())).toBe("not_ignored");
    expect(canUnignore(state({ active: false, ignoredBy: "qianwei" }))).toBe(
      "not_active",
    );
  });
});

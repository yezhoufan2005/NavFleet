import { describe, it, expect } from "vitest";
import { describeUserAgent } from "@/lib/userAgent";

describe("describeUserAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
      "Edge 131 · Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Firefox 133 · macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari 18 · iOS",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome 130 · Linux",
    ],
  ])("names %s", (raw, expected) => {
    expect(describeUserAgent(raw)).toBe(expected);
  });

  it("falls back to the raw string for an unrecognised client, and says so for none", () => {
    expect(describeUserAgent("curl/8.7.1")).toBe("curl/8.7.1");
    expect(describeUserAgent("")).toBe("未知设备");
    expect(describeUserAgent(null)).toBe("未知设备");
  });
});

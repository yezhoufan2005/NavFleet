/**
 * The demo accounts' devices: the real browser each person signs in with, and the office address
 * it sits at. `seed:demo` signs in from them; `sim accounts` puts the addresses back on what the
 * seed recorded.
 *
 * The seed sends the address as `X-Forwarded-For`, but the backend only trusts the hops it is told
 * to (TRUST_PROXY: the compose nginx, one hop), so a client-supplied forwarded address is never
 * believed — sessions and sign-ins come out at the address nginx saw, the Docker host's gateway;
 * against a bare dev backend, loopback. That is the backend doing its job, so the demo restores the
 * office addresses in the database rather than trusting one more hop.
 */

export interface DemoDevice {
  userAgent: string;
  ip: string;
}

// Real browsers' user-agent strings, so 个人中心 names them (`Chrome 131 · macOS`) as it would a
// colleague's machine.
export const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  chromeWall:
    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

/** One session per device; an account missing here (new hire, leaver, locked) never signs in. */
export const DEMO_DEVICES: Readonly<Record<string, readonly DemoDevice[]>> = {
  lifang: [
    { userAgent: UA.chromeMac, ip: "10.20.1.15" },
    { userAgent: UA.safariIpad, ip: "10.20.9.41" },
  ],
  zhaoyun: [
    { userAgent: UA.edgeWindows, ip: "10.20.3.21" },
    { userAgent: UA.chromeAndroid, ip: "10.20.9.77" },
  ],
  qianwei: [{ userAgent: UA.firefoxLinux, ip: "10.20.3.22" }],
  liuqiang: [
    { userAgent: UA.chromeAndroid, ip: "10.20.9.103" },
    { userAgent: UA.chromeIphone, ip: "10.20.9.118" },
  ],
  chenjing: [{ userAgent: UA.edgeWindows, ip: "10.20.5.8" }],
  huangmin: [{ userAgent: UA.safariMac, ip: "10.20.1.33" }],
  sunli: [
    { userAgent: UA.chromeMac, ip: "10.20.1.52" },
    { userAgent: UA.chromebook, ip: "10.20.1.53" },
  ],
  wall01: [{ userAgent: UA.chromeWall, ip: "10.20.2.10" }],
};

/** The guessing script that locks the contractor account out, from outside the office range. */
export const LOCKOUT_DEVICE: DemoDevice = {
  userAgent: "python-requests/2.32.3",
  ip: "172.31.44.19",
};
export const LOCKOUT_USERNAME = "wugang";

/** The seed's own administrative session: a deployment script, not anyone's browser. */
export const SEED_SCRIPT_DEVICE: DemoDevice = { userAgent: "NavFleet seed-demo", ip: "10.20.0.2" };

/**
 * Where each sign-in the seed made should say it came from: the device whose user-agent it carried,
 * for that account. `null` for anything the seed did not make (someone's own browser).
 */
export const demoAddressOf = (username: string, userAgent: string): string | null => {
  if (userAgent === SEED_SCRIPT_DEVICE.userAgent) return SEED_SCRIPT_DEVICE.ip;
  if (username === LOCKOUT_USERNAME && userAgent === LOCKOUT_DEVICE.userAgent) {
    return LOCKOUT_DEVICE.ip;
  }
  return DEMO_DEVICES[username]?.find((device) => device.userAgent === userAgent)?.ip ?? null;
};

/**
 * A session's device as a person recognises it — `Chrome 131 · macOS` — from the raw user-agent
 * string the backend records. Only the browsers and systems a console is realistically opened in
 * are named; anything else falls back to the raw string (still shown in full on hover).
 *
 * Order matters: Edge and Opera carry "Chrome/" in their UA, and Chrome carries "Safari/", so the
 * more specific token is tested first.
 */
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/Firefox\/(\d+)/, "Firefox"],
  [/(?:Chrome|CriOS)\/(\d+)/, "Chrome"],
  [/Version\/(\d+)(?:\.\d+)*.*Safari\//, "Safari"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

export const describeUserAgent = (raw: string | null | undefined): string => {
  const ua = raw?.trim() ?? "";
  if (!ua) return "未知设备";
  let browser = "";
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(ua);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? "";
  return [browser, system].filter(Boolean).join(" · ") || ua;
};

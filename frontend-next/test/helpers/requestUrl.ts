/**
 * The request target of a `fetch` call, as a string.
 *
 * `String(input)` is what four specs used to do, and it is wrong on one of the three arms
 * `RequestInfo | URL` allows: `Request` has no meaningful `toString`, so a `Request`
 * argument records the literal `"[object Request]"` and every `includes(...)` /
 * `endsWith(...)` against it silently fails to match. Every spec here passes a string or a
 * `URL` today, which is why nothing caught it — `no-base-to-string` (P0-f 第 3 批) did.
 *
 * Shared rather than repeated: a fetch stub that mis-reads its own argument is the kind of
 * defect that makes a test pass for the wrong reason, and one copy is one place to fix.
 */
export const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

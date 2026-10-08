/**
 * Report-code dictionary — built-in-bound convenience wrappers.
 *
 * The table, the wire type, and the pure merge/lookup moved to `@navfleet/shared` in Phase
 * 16C-2 (the backend layers a deployment's `codebook.json` over the built-in base and 下发s
 * the merged result, and the backend does not depend on this package). What stays here is a
 * thin binding of `describeCode` / `describeDeviceCodes` / `lookupReportCode` to the
 * **built-in** table. The v3 console describes against the deployment codebook it fetches
 * instead (`describeCodeWith` with the merged index from `GET /api/v1/codebook`), so these
 * built-in-bound helpers currently have no console caller; they remain as the package's
 * documented fallback API over the static table, exercised by `test/reportCodes.test.ts`.
 */

import type {
  CodeState,
  DescribedCode,
  ReportCodeEntry,
} from "@navfleet/shared";
import {
  DEFAULT_CODEBOOK_INDEX,
  DEFAULT_REPORT_CODES,
  describeCodeWith,
  describeDeviceCodesWith,
  lookupCode,
} from "@navfleet/shared";

export type {
  CodeChannel,
  CodeImpact,
  CodeImpactMeta,
  CodeSubsystem,
  DescribedCode,
  ReportCodeEntry,
} from "@navfleet/shared";
export { CODE_IMPACTS, CODE_SUBSYSTEMS } from "@navfleet/shared";

/** The whole built-in table, for the reference page. Frozen: it is data, not scratch space. */
export const REPORT_CODES: readonly ReportCodeEntry[] = DEFAULT_REPORT_CODES;

/** What a code number means in the built-in table, or `null` when it does not know. */
export const lookupReportCode = (code: unknown): ReportCodeEntry | null =>
  lookupCode(DEFAULT_CODEBOOK_INDEX, code);

/** A code plus what the device said, resolved against the built-in table. */
export const describeCode = (
  state: CodeState | null | undefined,
): DescribedCode | null => describeCodeWith(DEFAULT_CODEBOOK_INDEX, state);

/** The three channels of one device, described against the built-in table, worst-first. */
export const describeDeviceCodes = (
  device: Parameters<typeof describeDeviceCodesWith>[1],
): {
  channel: import("@navfleet/shared").CodeChannel;
  described: DescribedCode;
}[] => describeDeviceCodesWith(DEFAULT_CODEBOOK_INDEX, device);

import { computed, ref } from "vue";
import { fleetApi } from "@navfleet/fleet-core";
import {
  DEFAULT_REPORT_CODES,
  buildCodebookIndex,
  describeDeviceCodesWith,
  type CodeChannel,
  type CodeState,
  type DescribedCode,
  type ReportCodeEntry,
} from "@navfleet/shared";

/**
 * The report-code dictionary the console renders against (Phase 16C-2).
 *
 * The device-detail card used to describe codes against `@navfleet/fleet-core`'s built-in
 * table, so it showed the reference meanings even when a deployment had loaded its own 码表.
 * This composable fetches the table **in effect** — the built-in base with the deployment's
 * `codebook.json` layered over it, from `GET /api/v1/codebook` — and describes against that.
 *
 * Module-level singleton: one fetch is shared by every consumer (the device-detail card and
 * the admin 报码字典 page), and `entries` starts at the built-in table so `describeDevice`
 * always resolves — a first paint before the fetch lands shows built-in meanings rather than
 * nothing, then refreshes. Admin import replaces `entries` with the merged table the backend
 * returns, so the page reflects the change without a reload.
 */
type LoadStatus = "idle" | "loading" | "ready" | "error";

const entries = ref<ReportCodeEntry[]>([...DEFAULT_REPORT_CODES]);
const status = ref<LoadStatus>("idle");
let inflight: Promise<void> | null = null;

const index = computed(() => buildCodebookIndex(entries.value));

const load = async (force = false): Promise<void> => {
  if (!force && (status.value === "ready" || inflight)) {
    await inflight;
    return;
  }
  status.value = "loading";
  inflight = (async () => {
    try {
      const { items } = await fleetApi.getCodebook();
      entries.value = items;
      status.value = "ready";
    } catch {
      // Keep whatever entries we have (built-in, or a prior successful load) and let the
      // caller surface the error state; a code lookup still resolves against those.
      status.value = "error";
    } finally {
      inflight = null;
    }
  })();
  await inflight;
};

/** Replace the deployment codebook (admin) and adopt the merged table the backend returns. */
const importCodebook = async (items: ReportCodeEntry[]): Promise<void> => {
  const result = await fleetApi.importCodebook(items);
  entries.value = result.items;
  status.value = "ready";
};

/** Reset module state between tests. */
export const __resetCodebook = (): void => {
  entries.value = [...DEFAULT_REPORT_CODES];
  status.value = "idle";
  inflight = null;
};

export const useCodebook = () => ({
  entries: computed(() => entries.value),
  status: computed(() => status.value),
  index,
  load,
  importCodebook,
  describeDevice: (
    device:
      | Pick<
          { errorCode: CodeState; warningCode: CodeState; infoCode: CodeState },
          "errorCode" | "warningCode" | "infoCode"
        >
      | null
      | undefined,
  ): { channel: CodeChannel; described: DescribedCode }[] =>
    describeDeviceCodesWith(index.value, device),
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { ReportCodeEntry } from "@navfleet/shared";
import CodebookView from "@/views/admin/CodebookView.vue";
import { useCodebook, __resetCodebook } from "@/composables/useCodebook";

/**
 * 报码字典 — the admin page and the composable behind it (Phase 16C-2).
 *
 * The page renders the table **in effect** (built-in ⊕ deployment codebook), exports it as a
 * file, and imports a replacement. The composable is a module-level singleton, so every case
 * resets it; the point of most cases is which path a given file takes, not merely that
 * something rendered.
 */
enableAutoUnmount(afterEach);

const ENTRY: ReportCodeEntry = {
  code: 2301,
  channel: "warning",
  subsystem: "power",
  label: "本厂电量低",
  description: "低于本厂阈值",
  hint: "推去充电区",
  impact: "urgent",
};

const routerFor = (): Router =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/admin/codebook", component: CodebookView },
      { path: "/:rest(.*)*", component: { template: "<i />" } },
    ],
  });

const mountView = async () => {
  const router = routerFor();
  await router.push("/admin/codebook");
  await router.isReady();
  const wrapper = mount(CodebookView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  __resetCodebook();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCodebook", () => {
  it("loads the table in effect and describes a device against it", async () => {
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const codebook = useCodebook();
    await codebook.load();

    expect(codebook.status.value).toBe("ready");
    const rows = codebook.describeDevice({
      errorCode: { code: 0, info: "", stamp: null },
      warningCode: { code: 2301, info: "现场原文", stamp: null },
      infoCode: { code: 0, info: "", stamp: null },
    });
    expect(rows[0]?.described.label).toBe("本厂电量低");
  });

  it("keeps the built-in table and reports error when the fetch fails", async () => {
    vi.spyOn(fleetApi, "getCodebook").mockRejectedValue(new Error("HTTP 503"));
    const codebook = useCodebook();
    await codebook.load();

    expect(codebook.status.value).toBe("error");
    // A code still resolves — against the built-in table.
    const rows = codebook.describeDevice({
      errorCode: { code: 5102, info: "", stamp: null },
      warningCode: { code: 0, info: "", stamp: null },
      infoCode: { code: 0, info: "", stamp: null },
    });
    expect(rows[0]?.described.label).toBe("路径规划超时");
  });

  it("adopts the merged table an import returns", async () => {
    vi.spyOn(fleetApi, "importCodebook").mockResolvedValue({ items: [ENTRY] });
    const codebook = useCodebook();
    await codebook.importCodebook([ENTRY]);
    expect(codebook.entries.value).toEqual([ENTRY]);
  });
});

describe("CodebookView", () => {
  it("renders the table in effect", async () => {
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("本厂电量低");
    expect(wrapper.text()).toContain("2301");
  });

  it("exports the current table as a JSON blob", async () => {
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:codebook");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const wrapper = await mountView();

    const exportButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("导出"));
    await exportButton?.trigger("click");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  });

  it("imports a valid file: validates, PUTs, and adopts the result", async () => {
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [] });
    const importSpy = vi
      .spyOn(fleetApi, "importCodebook")
      .mockResolvedValue({ items: [ENTRY] });
    const wrapper = await mountView();

    const file = new File([JSON.stringify([ENTRY])], "codebook.json", {
      type: "application/json",
    });
    // jsdom's File.text() is unreliable across versions; pin it to the file's own content.
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(JSON.stringify([ENTRY])),
    });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();

    expect(importSpy).toHaveBeenCalledWith([ENTRY]);
  });

  it("rejects an invalid file client-side and never calls the API", async () => {
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [] });
    const importSpy = vi.spyOn(fleetApi, "importCodebook");
    const wrapper = await mountView();

    const file = new File(
      [JSON.stringify([{ ...ENTRY, code: 0 }])],
      "bad.json",
      {
        type: "application/json",
      },
    );
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(JSON.stringify([{ ...ENTRY, code: 0 }])),
    });
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [file],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();

    expect(importSpy).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });
});

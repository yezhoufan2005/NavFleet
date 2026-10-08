import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { ReportCodeEntry } from "@navfleet/shared";
import CodebookView from "@/views/admin/CodebookView.vue";
import { useCodebook, __resetCodebook } from "@/composables/useCodebook";
import { useAuth, __resetAuth } from "@/composables/useAuth";

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
      { path: "/deploy/codebook", component: CodebookView },
      { path: "/:rest(.*)*", component: { template: "<i />" } },
    ],
  });

const mountView = async () => {
  const router = routerFor();
  await router.push("/deploy/codebook");
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
  __resetAuth();
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

describe("CodebookView — row editing (codebook:write)", () => {
  const asWriter = (): void => {
    const auth = useAuth();
    auth.state.status = "authenticated";
    auth.state.user = { username: "admin", role: "admin" };
    auth.state.capabilities = ["codebook:write"];
  };
  const submitBodyForm = async () => {
    document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
    await flushPromises();
  };
  const clickRowButton = async (
    wrapper: Awaited<ReturnType<typeof mountView>>,
    label: string,
  ) => {
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === label)!
      .trigger("click");
    await flushPromises();
  };

  it("hides the row-edit affordances without codebook:write", async () => {
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const wrapper = await mountView();
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("新建报码")),
    ).toBe(false);
    expect(
      wrapper.findAll("button").some((b) => b.text().trim() === "编辑"),
    ).toBe(false);
  });

  it("creates a row and re-sends the whole table", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const put = vi
      .spyOn(fleetApi, "importCodebook")
      .mockResolvedValue({ items: [ENTRY] });
    const wrapper = await mountView();
    await clickRowButton(wrapper, "新建报码");

    (
      document.body.querySelector('input[type="number"]') as HTMLInputElement
    ).value = "4200";
    document.body
      .querySelector('input[type="number"]')!
      .dispatchEvent(new Event("input"));
    (
      document.body.querySelector('input[type="text"]') as HTMLInputElement
    ).value = "新报码";
    document.body
      .querySelector('input[type="text"]')!
      .dispatchEvent(new Event("input"));
    const areas = document.body.querySelectorAll("textarea");
    (areas[0] as HTMLTextAreaElement).value = "原因说明";
    areas[0]!.dispatchEvent(new Event("input"));
    (areas[1] as HTMLTextAreaElement).value = "处理建议";
    areas[1]!.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();

    expect(put).toHaveBeenCalledTimes(1);
    const sent = put.mock.calls[0]![0];
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      code: 4200,
      label: "新报码",
      description: "原因说明",
      hint: "处理建议",
      channel: "error",
      impact: "watch",
      subsystem: "navigation",
    });
  });

  it("blocks a duplicate code before writing", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const put = vi.spyOn(fleetApi, "importCodebook");
    const wrapper = await mountView();
    await clickRowButton(wrapper, "新建报码");
    (
      document.body.querySelector('input[type="number"]') as HTMLInputElement
    ).value = String(ENTRY.code);
    document.body
      .querySelector('input[type="number"]')!
      .dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();

    expect(put).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("已存在");
  });

  it("edits an existing row by code", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const put = vi
      .spyOn(fleetApi, "importCodebook")
      .mockResolvedValue({ items: [ENTRY] });
    const wrapper = await mountView();
    await clickRowButton(wrapper, "编辑");
    const label = document.body.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement;
    expect(label.value).toBe(ENTRY.label);
    label.value = "改名后";
    label.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();

    const sent = put.mock.calls[0]![0];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ code: ENTRY.code, label: "改名后" });
  });

  it("deletes a row by rewriting the table without it", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    const put = vi
      .spyOn(fleetApi, "importCodebook")
      .mockResolvedValue({ items: [] });
    const wrapper = await mountView();
    await clickRowButton(wrapper, "删除");
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    );
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toEqual([]);
  });

  it("maps a backend rejection to an inline message and keeps the dialog open", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getCodebook").mockResolvedValue({ items: [ENTRY] });
    vi.spyOn(fleetApi, "importCodebook").mockRejectedValue(
      new Error("invalid_codebook"),
    );
    const wrapper = await mountView();
    await clickRowButton(wrapper, "编辑");
    await submitBodyForm();
    expect(document.body.textContent).toContain("后端拒绝了这份码表");
  });
});

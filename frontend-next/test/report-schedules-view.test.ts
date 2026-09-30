import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { ReportScheduleConfig } from "@navfleet/shared";
import ReportSchedulesView from "@/views/admin/ReportSchedulesView.vue";
import { useAuth, __resetAuth } from "@/composables/useAuth";
import { __resetNotifications } from "@/composables/useNotifications";

/**
 * 定时报表 编辑页 (1.6.1). `fleetApi` is mocked; the editor is a table + create/edit dialog over a
 * variable-length schedule list (like 外发), so tests drive the reka-ui dialog (teleported to
 * `document.body`) and assert the whole-file payload `putReportsConfig` receives.
 */
enableAutoUnmount(afterEach);

const SCHEDULE: ReportScheduleConfig = {
  id: "daily-ops",
  enabled: true,
  range: "24h",
  time: "08:00",
  weekday: 1,
  smtpEnv: "REPORTS_SMTP_URL",
  from: "reports@fleet.local",
  recipients: [{ email: "ops@fleet.local" }, { user: "bob" }],
  groups: ["oncall"],
};

const asWriter = (): void => {
  const auth = useAuth();
  auth.state.status = "authenticated";
  auth.state.user = { username: "admin", role: "admin" };
  auth.state.capabilities = ["reports:write"];
};

let router: Router;
const mountView = async () => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/admin/reports", component: ReportSchedulesView }],
  });
  await router.push("/admin/reports");
  await router.isReady();
  const wrapper = mount(ReportSchedulesView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

const textInputs = () =>
  [
    ...document.body.querySelectorAll('input[type="text"]'),
  ] as HTMLInputElement[];
const submitBodyForm = async () => {
  document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
  await flushPromises();
};
const clickToolbar = async (
  wrapper: Awaited<ReturnType<typeof mountView>>,
  label: string,
) => {
  await wrapper
    .findAll("button")
    .find((button) => button.text().trim() === label)!
    .trigger("click");
  await flushPromises();
};

beforeEach(() => {
  __resetNotifications();
  vi.spyOn(fleetApi, "getReportsConfig").mockResolvedValue({
    config: { schedules: [SCHEDULE] },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetAuth();
  __resetNotifications();
});

describe("ReportSchedulesView — listing", () => {
  it("renders the schedules from the API", async () => {
    asWriter();
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("daily-ops");
    expect(wrapper.text()).toContain("近 24 小时");
    expect(wrapper.text()).toContain("周一");
  });

  it("hides the create/edit affordances without reports:write", async () => {
    // No capabilities seeded → read-only view of the (routing-gated) page.
    const wrapper = await mountView();
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("新建报表")),
    ).toBe(false);
    expect(
      wrapper.findAll("button").some((b) => b.text().trim() === "编辑"),
    ).toBe(false);
  });

  it("reports an error when the config cannot be loaded", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getReportsConfig").mockRejectedValue(
      new Error("HTTP 500"),
    );
    const wrapper = await mountView();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });
});

describe("ReportSchedulesView — create", () => {
  it("creates a schedule and writes the whole file", async () => {
    asWriter();
    const put = vi
      .spyOn(fleetApi, "putReportsConfig")
      .mockResolvedValue({ config: { schedules: [SCHEDULE] } });
    const wrapper = await mountView();
    await clickToolbar(wrapper, "新建报表");

    // Dialog is teleported; text inputs in order: id, time, smtpEnv, from, groups.
    const [idInput, timeInput, smtpInput, fromInput] = textInputs();
    idInput!.value = "weekly-kpi";
    idInput!.dispatchEvent(new Event("input"));
    timeInput!.value = "07:30";
    timeInput!.dispatchEvent(new Event("input"));
    smtpInput!.value = "KPI_SMTP_URL";
    smtpInput!.dispatchEvent(new Event("input"));
    fromInput!.value = "kpi@fleet.local";
    fromInput!.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();

    expect(put).toHaveBeenCalledTimes(1);
    const config = put.mock.calls[0]![0];
    // The new schedule is appended to the existing one (whole-file write).
    expect(config.schedules).toHaveLength(2);
    expect(config.schedules[1]).toMatchObject({
      id: "weekly-kpi",
      enabled: true,
      range: "24h",
      time: "07:30",
      smtpEnv: "KPI_SMTP_URL",
      from: "kpi@fleet.local",
    });
  });

  it("blocks a malformed send time before writing", async () => {
    asWriter();
    const put = vi.spyOn(fleetApi, "putReportsConfig");
    const wrapper = await mountView();
    await clickToolbar(wrapper, "新建报表");
    const [idInput, timeInput, smtpInput, fromInput] = textInputs();
    idInput!.value = "bad";
    idInput!.dispatchEvent(new Event("input"));
    timeInput!.value = "8am";
    timeInput!.dispatchEvent(new Event("input"));
    smtpInput!.value = "E";
    smtpInput!.dispatchEvent(new Event("input"));
    fromInput!.value = "a@b.c";
    fromInput!.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();

    expect(put).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("HH:MM");
  });
});

describe("ReportSchedulesView — edit & delete", () => {
  it("prefills and round-trips recipients, groups and weekday", async () => {
    asWriter();
    const put = vi
      .spyOn(fleetApi, "putReportsConfig")
      .mockResolvedValue({ config: { schedules: [SCHEDULE] } });
    const wrapper = await mountView();
    await clickToolbar(wrapper, "编辑");

    const textarea = document.body.querySelector("textarea")!;
    expect(textarea.value).toContain("ops@fleet.local");
    expect(textarea.value).toContain("@bob");
    await submitBodyForm();

    const saved = put.mock.calls[0]![0].schedules[0]!;
    expect(saved.recipients).toEqual([
      { email: "ops@fleet.local" },
      { user: "bob" },
    ]);
    expect(saved.groups).toEqual(["oncall"]);
    expect(saved.weekday).toBe(1);
  });

  it("deletes a schedule by rewriting the file without it", async () => {
    asWriter();
    const put = vi
      .spyOn(fleetApi, "putReportsConfig")
      .mockResolvedValue({ config: { schedules: [] } });
    const wrapper = await mountView();
    await clickToolbar(wrapper, "删除");
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    );
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0].schedules).toEqual([]);
  });

  it("maps a backend rejection to an inline message", async () => {
    asWriter();
    vi.spyOn(fleetApi, "putReportsConfig").mockRejectedValue(
      new Error("invalid_reports"),
    );
    const wrapper = await mountView();
    await clickToolbar(wrapper, "编辑");
    await submitBodyForm();
    expect(document.body.textContent).toContain("配置校验未通过");
  });
});

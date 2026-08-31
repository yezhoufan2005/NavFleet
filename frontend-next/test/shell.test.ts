import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
import type { Router } from "vue-router";
import { createPinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import App from "@/App.vue";
import { createAppRouter } from "@/router";
import { createAuthGuard } from "@/router/guards";
import { useAuth, __resetAuth } from "@/composables/useAuth";
import { __resetNotifications } from "@/composables/useNotifications";
import {
  __resetAlertSound,
  __setAudioContextFactory,
} from "@/composables/useAlertSound";
import { SIDEBAR_STORAGE_KEY } from "@/composables/useSidebar";
import { THEME_STORAGE_KEY } from "@/composables/useTheme";
import { acceptLastSocket, openedSockets, setViewportWidth } from "./setup";

/**
 * The shell as a whole: which of the three top-level states renders, and whether the
 * structural promises the Playwright suite matches on actually hold.
 *
 * Those promises are worth being explicit about, because the e2e specs assert them
 * by *role* and would fail somewhere confusing if the markup drifted:
 *
 * - exactly one `banner`, and it carries the product name
 * - two named `navigation` landmarks (主导航 and 面包屑) and no unnamed one
 * - no `navigation` at all while nobody is signed in
 * - a `main` that can take focus
 *
 * Every wrapper is unmounted between cases. The session is a module singleton, so a
 * wrapper left mounted keeps reacting to it with a router that has been thrown
 * away — which surfaces as "Unhandled error during execution of component update"
 * pointing at whichever test runs next.
 */
enableAutoUnmount(afterEach);

const ADMIN = { username: "admin", role: "admin" } as const;

/** A fleet whose name is not just the product name again — see `AppTopBar`. */
const FLEET = {
  fleetName: "北区仓储车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  devices: [{ deviceId: "agv-01", deviceName: "AGV 01", online: true }],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
let router: Router;

/**
 * Answers by endpoint rather than returning one body for everything.
 *
 * Signing in now starts the fleet bootstrap, so a single canned response would feed
 * the session payload to `/api/v1/fleet/snapshot` and leave the store holding a
 * device invented out of the `user` object. The tests that follow would still pass,
 * which is precisely the problem.
 */
const routedFetch = (
  session: Response,
  fleet: Response = jsonResponse(FLEET),
) =>
  vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/scenes"))
      return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes("/fleet/snapshot")) return Promise.resolve(fleet);
    return Promise.resolve(session);
  });

/**
 * Boots the app the way a browser does — mount first, then navigate — rather than
 * navigating before anything has asked the backend who we are. Done the other way
 * round, the guard on a gated route waits out its full timeout because the session
 * probe has not started yet.
 */
const mountApp = async (path = "/") => {
  router = createAppRouter(createMemoryHistory());
  router.beforeEach(createAuthGuard(useAuth().state));

  const wrapper = mount(App, {
    global: { plugins: [createPinia(), router] },
    attachTo: document.body,
  });

  await router.isReady();
  await flushPromises();

  if (path !== "/") {
    await router.push(path);
    await flushPromises();
  }
  return wrapper;
};

const signedIn = async (path = "/") => {
  fetchMock = routedFetch(jsonResponse({ user: ADMIN }));
  vi.stubGlobal("fetch", fetchMock);
  return mountApp(path);
};

const openSessionMenu = async (
  wrapper: Awaited<ReturnType<typeof mountApp>>,
): Promise<void> => {
  await wrapper.find("header button[aria-haspopup]").trigger("click");
  await flushPromises();
};

/** The menu renders through a portal, so it is in the body rather than the wrapper. */
const menuItems = (
  role: "menuitem" | "menuitemradio" | "menuitemcheckbox",
): HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>(`[role='${role}']`),
];

/**
 * jsdom has no Web Audio, so the top bar's sound control needs a context to unlock
 * against. Only the calls `useAlertSound` makes are provided — `alert-sound.test.ts`
 * is where the tone's shape is asserted.
 */
const fakeAudioContext = (): AudioContext => {
  // `state` has to actually flip: `unlock()` resolves `resume()` and then reads the
  // state back, so a permanently "suspended" stub stays locked forever.
  let state: AudioContextState = "suspended";
  return {
    get state() {
      return state;
    },
    currentTime: 0,
    destination: {},
    resume: () => {
      state = "running";
      return Promise.resolve();
    },
    createOscillator: () => ({
      frequency: { value: 0 },
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    }),
    createGain: () => ({
      gain: {
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    }),
  } as unknown as AudioContext;
};

beforeEach(() => {
  __resetAuth();
  __resetNotifications();
  __resetAlertSound();
  __setAudioContextFactory(fakeAudioContext);
  delete document.documentElement.dataset.theme;
  // Anonymous by default, and routed — so a test that signs in mid-case does not
  // hand the session payload to the fleet endpoints.
  fetchMock = routedFetch(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session states", () => {
  it("says it is working while the session probe is in flight", async () => {
    // A blank page during the probe is indistinguishable from a broken one.
    fetchMock.mockReturnValue(new Promise(() => undefined));
    router = createAppRouter(createMemoryHistory());
    const wrapper = mount(App, {
      global: { plugins: [createPinia(), router] },
    });
    await router.isReady();

    expect(wrapper.text()).toContain("正在加载…");
    expect(wrapper.find("nav").exists()).toBe(false);
  });

  it("renders the login form instead of the shell when anonymous", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const wrapper = await mountApp();

    expect(wrapper.text()).toContain("请登录以访问车队监控台");
    // The absence of any navigation is the access gate, not a styling choice.
    expect(wrapper.findAll("nav")).toHaveLength(0);
    expect(wrapper.find("#main-content").exists()).toBe(false);
  });

  it("renders the shell once the session is known", async () => {
    const wrapper = await signedIn();

    expect(wrapper.find("header").exists()).toBe(true);
    expect(wrapper.find("header").text()).toContain("智能车队监控平台");
    expect(wrapper.find("#main-content").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("请登录以访问车队监控台");
  });

  it("signs in from the form and swaps the login screen for the shell", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const wrapper = await mountApp();

    fetchMock.mockResolvedValueOnce(jsonResponse({ user: ADMIN }));
    await wrapper.find('input[name="username"]').setValue("admin");
    await wrapper.find('input[name="password"]').setValue("secret");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find("nav[aria-label='主导航']").exists()).toBe(true);
  });

  it("refuses to submit an empty form and explains why", async () => {
    // v1.0.0 returned silently from the handler, so on a browser that had not
    // enforced `required` the button looked dead.
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const wrapper = await mountApp();

    await wrapper.find("form").trigger("submit");
    expect(wrapper.text()).toContain("请输入用户名和密码");
    expect(fetchMock).toHaveBeenCalledTimes(1); // the probe only
  });
});

describe("landmarks", () => {
  it("has exactly one banner and two named navigations", async () => {
    const wrapper = await signedIn();

    expect(wrapper.findAll("header")).toHaveLength(1);
    // Both are named, because there are two of them: an unnamed one would make
    // "jump to navigation" a coin flip. DOM order follows the visual layout — the
    // top bar (which holds the trail) sits above the rail.
    const labels = wrapper
      .findAll("nav")
      .map((nav) => nav.attributes("aria-label"));
    expect(labels).toEqual(["面包屑", "主导航"]);
  });

  it("puts a skip link ahead of the navigation", async () => {
    // Five nav links sit between the top of the document and the content on every
    // page, so this is the difference between one keystroke and six.
    const wrapper = await signedIn();
    const skip = wrapper.find("a[href='#main-content']");

    expect(skip.exists()).toBe(true);
    expect(skip.text()).toBe("跳到主内容");
  });

  it("makes the content region focusable", async () => {
    const wrapper = await signedIn();
    expect(wrapper.find("#main-content").attributes("tabindex")).toBe("-1");
  });

  it("moves focus into the content after a navigation", async () => {
    // Otherwise a keyboard user who activates a nav link is still parked in the
    // sidebar and has to tab past all of it to reach what they asked for.
    const wrapper = await signedIn();
    await router.push("/alerts");
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.find("#main-content").element);
  });
});

describe("breadcrumbs", () => {
  it("shows one crumb for a top-level section", async () => {
    const wrapper = await signedIn("/alerts");
    expect(wrapper.find("nav[aria-label='面包屑']").text()).toContain("告警");
  });

  it("builds the trail from the nesting, not from a hand-kept list", async () => {
    const wrapper = await signedIn("/devices/agv-c12");
    const crumbs = wrapper
      .find("nav[aria-label='面包屑']")
      .findAll("li")
      .map((item) => item.text().replace(/^›\s*/, ""));

    expect(crumbs).toEqual(["设备", "设备详情"]);
  });

  it("does not link the page you are already on", async () => {
    const wrapper = await signedIn("/devices/agv-c12");
    const trail = wrapper.find("nav[aria-label='面包屑']");

    expect(trail.findAll("a")).toHaveLength(1);
    expect(trail.find("[aria-current='page']").text()).toBe("设备详情");
  });
});

describe("sidebar", () => {
  it("starts expanded and remembers being collapsed", async () => {
    const wrapper = await signedIn();
    const toggle = () => wrapper.find("header button");

    expect(toggle().attributes("aria-label")).toBe("收起侧栏");
    await toggle().trigger("click");

    expect(toggle().attributes("aria-label")).toBe("展开侧栏");
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");
  });

  it("restores the remembered width on the next visit", async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");
    // The module singleton has already read storage, so re-read it the way a fresh
    // tab would by importing into a clean module registry.
    vi.resetModules();
    const { useSidebar } = await import("@/composables/useSidebar");
    expect(useSidebar().preference.value).toBe("collapsed");
  });

  it("becomes a drawer below the lg breakpoint", async () => {
    // 240px of rail on a 900px tablet leaves too little for a map, so the rail is
    // not the user's choice down there.
    const wrapper = await signedIn();
    setViewportWidth(900);
    await flushPromises();

    expect(wrapper.find("header button").attributes("aria-label")).toBe(
      "打开导航",
    );
  });
});

describe("session menu", () => {
  it("names the signed-in user and their role on the trigger", async () => {
    const wrapper = await signedIn();
    const trigger = wrapper.find("header button[aria-haspopup]");

    expect(trigger.text()).toContain("admin");
    expect(trigger.text()).toContain("管理员");
  });

  it("signs out and returns to the login form", async () => {
    const wrapper = await signedIn();
    await openSessionMenu(wrapper);

    const logout = menuItems("menuitem").find((item) =>
      item.textContent?.includes("退出"),
    );
    expect(logout).toBeDefined();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    logout?.click();
    await flushPromises();

    expect(wrapper.text()).toContain("请登录以访问车队监控台");
  });

  it("carries the theme preference, which is why there is no settings page", async () => {
    const wrapper = await signedIn();
    await openSessionMenu(wrapper);

    // The menu also carries the sound preferences (13D-2), so this asserts the theme
    // group is intact rather than that it is the only radio group in the menu.
    const options = menuItems("menuitemradio");
    const labels = options.map((option) =>
      option.textContent?.replace(/[\s✓]/g, ""),
    );
    expect(labels.slice(0, 3)).toEqual(["跟随系统", "浅色", "深色"]);

    options.find((option) => option.textContent?.includes("深色"))?.click();
    await flushPromises();

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("document title", () => {
  it("names the current section once someone is signed in", async () => {
    await signedIn("/alerts");
    expect(document.title).toBe("告警 · 智能车队监控平台");
  });

  it("does not claim to be showing a section while nobody is signed in", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await mountApp();
    expect(document.title).toBe("智能车队监控平台");
  });
});

describe("the realtime indicator", () => {
  const indicator = (wrapper: Awaited<ReturnType<typeof mountApp>>) =>
    wrapper.find("header [role='status']");

  it("names the state in words, not only in colour", async () => {
    // A dot that only changes hue says nothing to a colourblind operator and
    // nothing at all to a screen reader. `role="status"` is what makes losing the
    // link announced rather than merely recoloured.
    const wrapper = await signedIn();
    await flushPromises();

    expect(indicator(wrapper).exists()).toBe(true);
    // A socket on its way up is not a socket coming back — this said 重连中 on
    // every cold start until the store learned the difference.
    expect(indicator(wrapper).text()).toBe("连接中");

    acceptLastSocket();
    await flushPromises();
    expect(indicator(wrapper).text()).toBe("实时");
  });

  it("reports a dropped link as a retry once it has been live", async () => {
    const wrapper = await signedIn();
    await flushPromises();
    acceptLastSocket();
    await flushPromises();

    openedSockets.at(-1)?.drop();
    await flushPromises();

    expect(indicator(wrapper).text()).toBe("重连中");
  });

  it("says the backend is down rather than showing an idle dot", async () => {
    fetchMock = routedFetch(
      jsonResponse({ user: ADMIN }),
      new Response(null, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountApp();
    await flushPromises();

    expect(indicator(wrapper).text()).toBe("后端离线");
  });

  it("shows the fleet's own name, and not a second copy of the product name", async () => {
    const wrapper = await signedIn();
    await flushPromises();
    expect(wrapper.find("header").text()).toContain("北区仓储车队");

    // A deployment that never named its fleet is called 智能车队, and
    // "智能车队监控平台 · 智能车队" spends the top bar restating the title.
    fetchMock = routedFetch(
      jsonResponse({ user: ADMIN }),
      jsonResponse({ ...FLEET, fleetName: "智能车队" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    __resetAuth();
    const plain = await mountApp();
    await flushPromises();

    expect(plain.find("header").text()).not.toContain("· 智能车队");
    expect(plain.find("header h1").text()).toBe("智能车队监控平台");
  });

  it("drops the socket on sign-out", async () => {
    // An authenticated socket left open behind the login screen is both a live
    // subscription nobody is watching and a claim the session no longer supports.
    const wrapper = await signedIn();
    await flushPromises();
    expect(openedSockets.at(-1)?.closed).toBe(false);

    await openSessionMenu(wrapper);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    menuItems("menuitem")
      .find((item) => item.textContent?.includes("退出"))
      ?.click();
    await flushPromises();

    expect(openedSockets.at(-1)?.closed).toBe(true);
  });
});

describe("the wall display", () => {
  it("renders without the shell", async () => {
    const wrapper = await signedIn("/wall");

    expect(wrapper.text()).toContain("大屏值班模式");
    // No sidebar, no top bar, no session menu: it has to be non-interactive.
    expect(wrapper.find("header").exists()).toBe(false);
    expect(wrapper.findAll("nav")).toHaveLength(0);
  });
});

describe("the sound control", () => {
  /**
   * The control is both the state readout and the unlock gesture, so what matters is
   * that it *reports* being unable to sound rather than being quietly silent — that
   * state is indistinguishable from "nothing is wrong".
   */
  it("says sound is not enabled until someone enables it", async () => {
    const wrapper = await signedIn();
    const control = wrapper
      .findAll("header button")
      .find((button) => button.text().includes("声音"));

    expect(control?.text()).toContain("声音未启用");
    expect(control?.attributes("aria-pressed")).toBe("false");
    expect(control?.attributes("title")).toContain("浏览器要求先有一次点击");
  });

  it("carries the three sound preferences in the session menu", async () => {
    const wrapper = await signedIn();
    await openSessionMenu(wrapper);

    const labels = menuItems("menuitemradio")
      .concat(menuItems("menuitemcheckbox"))
      .map((item) => item.textContent?.replace(/[\s✓]/g, ""));

    expect(labels).toContain("静音");
    expect(labels.some((label) => label?.startsWith("音量"))).toBe(true);
    expect(labels.some((label) => label?.startsWith("免打扰"))).toBe(true);
  });

  /**
   * After unlocking, the same control mutes and unmutes.
   *
   * It used to do nothing once unlocked: a control that reports a state, invites a
   * click and then ignores it. Found by manual review, and it is the kind of dead
   * affordance no assertion here was watching for — the old tests only checked the
   * locked label.
   */
  it("becomes the mute switch once it has been unlocked", async () => {
    const wrapper = await signedIn();
    // Found by accessible name rather than visible text: the visible word *is* the
    // state, so it stops containing "声音" the moment the control reports 已静音.
    const control = () => wrapper.get("header button[aria-label^='告警声音']");

    expect(control().text()).toContain("声音未启用");

    // First click is the browser's required gesture.
    await control().trigger("click");
    await flushPromises();
    expect(control().text()).toContain("声音已启用");
    expect(control().attributes("aria-pressed")).toBe("true");

    // Second click mutes, third unmutes — and the label follows both ways.
    await control().trigger("click");
    await flushPromises();
    expect(control().text()).toContain("已静音");
    expect(control().attributes("aria-pressed")).toBe("false");

    await control().trigger("click");
    await flushPromises();
    expect(control().text()).toContain("声音已启用");
  });

  it("keeps the top bar and the session menu on one mute state", async () => {
    // Two controls for the same preference, so they must not be able to disagree.
    const wrapper = await signedIn();
    const control = () => wrapper.get("header button[aria-label^='告警声音']");

    await control().trigger("click");
    await flushPromises();
    await control().trigger("click");
    await flushPromises();

    await openSessionMenu(wrapper);
    const mute = menuItems("menuitemcheckbox").find((item) =>
      item.textContent?.includes("静音"),
    );
    expect(mute?.getAttribute("aria-checked")).toBe("true");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ALERT_SOUND_KEYS,
  NIGHT_WINDOW,
  SOUND_THROTTLE_MS,
  isQuietAt,
  useAlertSound,
  __resetAlertSound,
  __setAudioContextFactory,
} from "@/composables/useAlertSound";

/**
 * Audible criticals. The behaviours worth pinning are the ones that decide whether
 * the feature survives a shift rather than getting muted: that it never sounds for a
 * 预警, that signing in to an existing pile of criticals is quiet, and that being
 * unable to sound is *reported* rather than silent.
 *
 * jsdom has no Web Audio, so the context is faked. That is also what makes the shape
 * of the sound assertable at all — the reason the module generates a tone instead of
 * playing a bundled file.
 */
interface FakeOscillator {
  frequency: { value: number };
  connected: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
}

const oscillators: FakeOscillator[] = [];
const gains: { peak: number }[] = [];
let contextState: AudioContextState = "suspended";
let resumeCalls = 0;
let resumeRejects = false;

const fakeContext = (): AudioContext => {
  const context = {
    get state() {
      return contextState;
    },
    currentTime: 0,
    destination: {},
    resume: () => {
      resumeCalls += 1;
      if (resumeRejects) return Promise.reject(new Error("blocked"));
      contextState = "running";
      return Promise.resolve();
    },
    createOscillator: () => {
      const oscillator: FakeOscillator = {
        frequency: { value: 0 },
        connected: false,
        startedAt: null,
        stoppedAt: null,
      };
      oscillators.push(oscillator);
      return {
        frequency: oscillator.frequency,
        connect: () => {
          oscillator.connected = true;
        },
        start: (at: number) => {
          oscillator.startedAt = at;
        },
        stop: (at: number) => {
          oscillator.stoppedAt = at;
        },
      };
    },
    createGain: () => {
      const record = { peak: 0 };
      gains.push(record);
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: (value: number) => {
            record.peak = Math.max(record.peak, value);
          },
        },
        connect: () => undefined,
      };
    },
  };
  return context as unknown as AudioContext;
};

const soundsPlayed = () => oscillators.length / 2;

beforeEach(() => {
  localStorage.clear();
  oscillators.length = 0;
  gains.length = 0;
  contextState = "suspended";
  resumeCalls = 0;
  resumeRejects = false;
  __resetAlertSound();
  __setAudioContextFactory(fakeContext);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the quiet window", () => {
  it("wraps across midnight, which is the whole reason it is a function", () => {
    // `from <= hour && hour < to` silently disables the window whenever it starts
    // later than it ends — which is every night window there is.
    const at = (hour: number) => new Date(2026, 7, 30, hour, 30);

    expect(isQuietAt("night", at(23))).toBe(true);
    expect(isQuietAt("night", at(2))).toBe(true);
    expect(isQuietAt("night", at(NIGHT_WINDOW.fromHour))).toBe(true);
    expect(isQuietAt("night", at(NIGHT_WINDOW.toHour))).toBe(false);
    expect(isQuietAt("night", at(13))).toBe(false);
  });

  it("is off unless asked for", () => {
    expect(isQuietAt("off", new Date(2026, 7, 30, 3, 0))).toBe(false);
  });
});

describe("unlocking", () => {
  it("needs a gesture, and says so until it gets one", () => {
    // Silently not sounding is the one behaviour that must never happen: it is
    // indistinguishable from "nothing is wrong".
    const sound = useAlertSound();

    expect(sound.unlocked.value).toBe(false);
    expect(sound.silentReason.value).toBe("locked");
  });

  it("resumes the context and plays once, so the person learns it worked", async () => {
    const sound = useAlertSound();
    await sound.unlock();

    expect(resumeCalls).toBe(1);
    expect(sound.unlocked.value).toBe(true);
    expect(soundsPlayed()).toBe(1);
    expect(sound.silentReason.value).toBe("");
  });

  it("stays locked, without throwing, when the browser refuses", async () => {
    resumeRejects = true;
    const sound = useAlertSound();

    await expect(sound.unlock()).resolves.toBe(false);
    expect(sound.unlocked.value).toBe(false);
    expect(soundsPlayed()).toBe(0);
  });

  it("does not survive a reload, because the gesture did not either", () => {
    const sound = useAlertSound();
    __resetAlertSound();
    expect(sound.unlocked.value).toBe(false);
  });
});

describe("coming back after a reload", () => {
  /** A fresh document in a browser that enabled sound at some earlier point. */
  const reloadedWithSoundOn = async () => {
    const first = useAlertSound();
    await first.unlock();
    expect(localStorage.getItem(ALERT_SOUND_KEYS.armed)).toBe("1");
    __resetAlertSound();
    contextState = "suspended";
    oscillators.length = 0;
    resumeCalls = 0;
    return useAlertSound();
  };

  it("remembers the choice even though it cannot remember the gesture", async () => {
    // 14A acceptance read 声音未启用 after every refresh as the setting being forgotten.
    // Two different facts: the preference is intact, and the browser is waiting for a
    // click. Only one of them is something the operator did.
    const sound = await reloadedWithSoundOn();

    expect(sound.armed.value).toBe(true);
    expect(sound.unlocked.value).toBe(false);
    expect(sound.silentReason.value).toBe("pending");
  });

  it("takes the next click anywhere as the gesture, and stays quiet about it", async () => {
    const sound = await reloadedWithSoundOn();

    window.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    await Promise.resolve();

    expect(resumeCalls).toBe(1);
    expect(sound.unlocked.value).toBe(true);
    expect(sound.silentReason.value).toBe("");
    // No confirmation blip: this click was aimed at something else, and a beep with
    // nothing wrong teaches the opposite of what the sound means.
    expect(soundsPlayed()).toBe(0);
  });

  it("takes a keypress too, since a keyboard operator may never produce a click", async () => {
    const sound = await reloadedWithSoundOn();

    window.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    await Promise.resolve();

    expect(sound.unlocked.value).toBe(true);
  });

  it("does not arm a browser that never asked for sound", async () => {
    // Arming on any first click would give everyone audible criticals they never opted
    // into — the failure mode that gets speakers unplugged.
    const sound = useAlertSound();
    expect(sound.armed.value).toBe(false);

    window.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();

    expect(resumeCalls).toBe(0);
    expect(sound.silentReason.value).toBe("locked");
  });
});

describe("what gets announced", () => {
  const live = async () => {
    const sound = useAlertSound();
    await sound.unlock();
    oscillators.length = 0; // the unlock's own confirmation blip
    return sound;
  };

  it("stays quiet on the first observation, however much is already wrong", async () => {
    // Signing in to a fleet with four criticals must not play four sounds.
    const sound = await live();

    expect(sound.announce(["a", "b", "c", "d"])).toBe(false);
    expect(soundsPlayed()).toBe(0);
  });

  it("sounds for a condition that appears afterwards", async () => {
    const sound = await live();
    sound.announce(["a"]);

    expect(sound.announce(["a", "b"])).toBe(true);
    expect(soundsPlayed()).toBe(1);
  });

  it("says nothing when the set has not changed", async () => {
    const sound = await live();
    sound.announce(["a"]);

    expect(sound.announce(["a"])).toBe(false);
  });

  it("says nothing when a condition merely clears", async () => {
    const sound = await live();
    sound.announce(["a", "b"]);

    expect(sound.announce(["a"])).toBe(false);
  });

  it("sounds again when a cleared condition comes back", async () => {
    const sound = await live();
    // No throttle to wait out: nothing has sounded yet in this test, because the
    // first observation only seeds and the second had nothing fresh.
    sound.announce(["a"]);
    sound.announce([]);

    expect(sound.announce(["a"])).toBe(true);
  });

  it("collapses a burst into one sound", async () => {
    // Twenty conditions arriving together is one event to a person in the room.
    const sound = await live();
    sound.announce([]);

    expect(sound.announce(["a"])).toBe(true);
    expect(sound.announce(["a", "b"])).toBe(false);
    expect(soundsPlayed()).toBe(1);
  });

  it("sounds again once the throttle window has passed", async () => {
    vi.useFakeTimers();
    const sound = await live();
    sound.announce([]);
    sound.announce(["a"]);

    vi.advanceTimersByTime(SOUND_THROTTLE_MS + 1);
    expect(sound.announce(["a", "b"])).toBe(true);
  });

  it("consumes ids while silent, so unmuting does not replay the shift", async () => {
    // Coming back from lunch should not sound for everything that happened while the
    // room was quiet — those conditions are already on screen.
    const sound = await live();
    sound.announce([]);
    sound.setMuted(true);

    expect(sound.announce(["a"])).toBe(false);
    sound.setMuted(false);
    expect(sound.announce(["a"])).toBe(false);
  });
});

describe("the three preferences", () => {
  it("mutes, and says that is why it is silent", async () => {
    const sound = useAlertSound();
    await sound.unlock();
    sound.setMuted(true);

    expect(sound.silentReason.value).toBe("muted");
    expect(localStorage.getItem(ALERT_SOUND_KEYS.muted)).toBe("1");
  });

  it("previews the volume it was just set to", async () => {
    const sound = useAlertSound();
    await sound.unlock();
    oscillators.length = 0;
    gains.length = 0;

    sound.setVolume("high");
    expect(soundsPlayed()).toBe(1);
    const loud = Math.max(...gains.map((gain) => gain.peak));

    gains.length = 0;
    sound.setVolume("low");
    expect(Math.max(...gains.map((gain) => gain.peak))).toBeLessThan(loud);
  });

  it("does not preview a volume change while muted", async () => {
    const sound = useAlertSound();
    await sound.unlock();
    sound.setMuted(true);
    oscillators.length = 0;

    sound.setVolume("high");
    expect(soundsPlayed()).toBe(0);
  });

  it("reports the quiet window as the reason, distinctly from muted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 30, 23, 30));
    const sound = useAlertSound();
    await sound.unlock();
    sound.setQuietHours("night");

    expect(sound.silentReason.value).toBe("quiet");
  });

  it("remembers all three across a reload", () => {
    const sound = useAlertSound();
    sound.setMuted(true);
    sound.setVolume("low");
    sound.setQuietHours("night");
    __resetAlertSound();

    const restored = useAlertSound();
    expect(restored.muted.value).toBe(true);
    expect(restored.volume.value).toBe("low");
    expect(restored.quietHours.value).toBe("night");
  });

  it("ignores a stored value it does not recognise", () => {
    localStorage.setItem(ALERT_SOUND_KEYS.volume, "deafening");
    __resetAlertSound();

    expect(useAlertSound().volume.value).toBe("medium");
  });
});

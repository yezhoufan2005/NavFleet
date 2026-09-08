import { computed, readonly, ref } from "vue";

/**
 * Audible alerts for critical conditions.
 *
 * Four decisions, and each of them is the difference between a feature and a switch
 * everyone turns off:
 *
 * ## 1. Critical only
 *
 * Warnings and notices are silent, by design (11C decision 4). A monitoring console
 * that beeps at every 预警 gets its volume turned down within a shift, and a muted
 * speaker is worse than no sound at all — it looks like coverage while providing none.
 * The whole value of the sound is that it is rare enough to mean something.
 *
 * ## 2. The unlock is the affordance
 *
 * Browsers refuse to start audio without a prior user gesture: an `AudioContext`
 * created before one begins `suspended` and stays there. So the console cannot simply
 * decide to be audible — someone has to click something. Rather than hide that behind
 * a hopeful `play()` that silently fails, the control that *reports* the state is also
 * the one that unlocks it. The click a person makes to say "make sound work" is
 * exactly the gesture the policy requires.
 *
 * Until it happens, the console says so. Silently not sounding is the one behaviour
 * that must never happen, because it is indistinguishable from "nothing is wrong".
 *
 * **The choice survives a reload; the gesture cannot.** 14A acceptance reported that
 * refreshing put the console back to 声音未启用, which read as the setting having been
 * forgotten. It had not been — a fresh document has had no gesture, and no amount of
 * stored state changes that. So two things are separated here:
 *
 * - *Armed* means "this login session has enabled alert sound, deliberately". It is kept
 *   in `sessionStorage`, so it survives a reload and dies with the tab, and it is cleared
 *   when the session ends — see `disarmAlertSound`.
 * - *Unlocked* is a property of this document, and cannot persist.
 *
 * Arming is **per login**, not per browser, and that is 14H's correction. It used to live
 * in `localStorage`, which made "已启用过" a permanent property of the machine: a shared
 * dispatch terminal stayed armed for whoever sat down next, and the readout could never
 * ask a new operator for the one click it needs. The shape acceptance asked for is
 * 待就绪 → one click → 响应, holding across refreshes, and 待就绪 again after a logout.
 *
 * When armed, the next gesture anywhere on the page resumes the context — no second
 * trip to the control — and the readout stays 告警响应 in between rather than nagging,
 * because that window almost never contains an alert and the claim is withdrawn the
 * instant one proves it wrong. Arming is deliberately **not** the default: a console that
 * starts beeping at an operator who never asked for sound is the failure mode that gets
 * speakers unplugged.
 *
 * ## 3. The first observation seeds, it does not announce
 *
 * Signing in to a fleet that already has four criticals must not play four sounds.
 * The first call records what is already there and stays quiet; only conditions that
 * appear *after* that are announced. This is why `announce` takes the whole current
 * set rather than a single alert.
 *
 * ## 4. A tone, not an audio file
 *
 * Web Audio rather than a bundled asset: no binary blob in the repository, no fetch
 * to fail at the moment it matters, and — the reason that decided it — the shape of
 * the sound is then testable. A fake `AudioContext` can assert that two notes were
 * scheduled at the configured volume; an `<audio>` element can only be asserted to
 * have been asked to play.
 */

export type SoundVolume = "low" | "medium" | "high";
export type QuietHours = "off" | "all" | "night";

const MUTED_KEY = "navfleet:alert-sound-muted";
const VOLUME_KEY = "navfleet:alert-sound-volume";
const QUIET_KEY = "navfleet:alert-sound-quiet";
const ARMED_KEY = "navfleet:alert-sound-armed";

/** Peak gain per setting. Deliberately well below 1 — this is a room, not headphones. */
const VOLUME_GAIN: Record<SoundVolume, number> = {
  low: 0.08,
  medium: 0.2,
  high: 0.45,
};

/** The one preset window. A free-form range needs a form; see the note in 13D-2. */
export const NIGHT_WINDOW = { fromHour: 22, toHour: 8 } as const;

/** Two notes, rising — recognisable without being an alarm. */
const NOTES: readonly { hz: number; at: number; for: number }[] = [
  { hz: 660, at: 0, for: 0.12 },
  { hz: 880, at: 0.14, for: 0.18 },
];

/** No more than one sound per this window, however many conditions arrive at once. */
export const SOUND_THROTTLE_MS = 4_000;

/**
 * Which storage area a value belongs to, which is a decision rather than a detail.
 *
 * 静音 / 音量 / 免打扰 describe how this browser should behave and outlive everything, so
 * they are `local`. Arming is not that kind of setting: it belongs to **the login
 * session**, so it is `session` — it survives a reload, dies with the tab, and is cleared
 * by `disarmAlertSound` when the session ends.
 */
type StorageArea = "local" | "session";

const areaOf = (area: StorageArea): Storage =>
  area === "session" ? sessionStorage : localStorage;

const readStored = <T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
  area: StorageArea = "local",
): T => {
  try {
    const stored = areaOf(area).getItem(key);
    return (allowed as readonly string[]).includes(stored ?? "")
      ? (stored as T)
      : fallback;
  } catch {
    return fallback;
  }
};

const write = (
  key: string,
  value: string,
  area: StorageArea = "local",
): void => {
  try {
    areaOf(area).setItem(key, value);
  } catch {
    // Storage blocked; the choice still holds for this session.
  }
};

/** Module singletons: one speaker per tab. */
const muted = ref(readStored(MUTED_KEY, ["0", "1"] as const, "0") === "1");
const volume = ref<SoundVolume>(
  readStored(VOLUME_KEY, ["low", "medium", "high"] as const, "medium"),
);
const quietHours = ref<QuietHours>(
  readStored(QUIET_KEY, ["off", "all", "night"] as const, "off"),
);

/** Session-only: an unlock cannot outlive the page that performed the gesture. */
const unlocked = ref(false);
/** Session-scoped: whether **this login** has deliberately enabled alert sound. */
const armed = ref(
  readStored(ARMED_KEY, ["0", "1"] as const, "0", "session") === "1",
);
/**
 * Set the first time a critical condition arrives that we could **not** sound because the
 * browser was still waiting for a gesture. See `silentReason` for why this exists at all.
 */
const missedForGesture = ref(false);
let audioContext: AudioContext | null = null;
let announcedIds = new Set<string>();
let seeded = false;
let lastSoundAt = 0;

/**
 * Is `at` inside the quiet window?
 *
 * Exported because the wrap across midnight is exactly the kind of comparison that
 * looks right and is wrong: `from <= hour && hour < to` silently disables the window
 * whenever it starts later than it ends, which is every night window there is.
 *
 * `all` is not a window at all — it is "never make a sound" expressed in the same
 * control, which is what someone means by 免打扰 全天. Kept here rather than folded into
 * `muted` because the two answer different questions: mute is a switch someone flips for
 * the next few minutes, 免打扰 is a standing rule, and the top bar says which of the two
 * is keeping the room quiet.
 */
export const isQuietAt = (setting: QuietHours, at: Date): boolean => {
  if (setting === "off") return false;
  if (setting === "all") return true;
  const hour = at.getHours();
  const { fromHour, toHour } = NIGHT_WINDOW;
  return fromHour <= toHour
    ? hour >= fromHour && hour < toHour
    : hour >= fromHour || hour < toHour;
};

type ContextFactory = () => AudioContext;

let contextFactory: ContextFactory = () =>
  new (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext
  )();

/** Test seam. The real factory reaches for a browser global that jsdom lacks. */
export const __setAudioContextFactory = (factory: ContextFactory): void => {
  contextFactory = factory;
};

const play = (): void => {
  if (!audioContext) return;
  const gain = VOLUME_GAIN[volume.value];
  const startedAt = audioContext.currentTime;

  for (const note of NOTES) {
    const oscillator = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    oscillator.frequency.value = note.hz;
    // Ramped rather than switched: a square-edged gain change clicks audibly.
    envelope.gain.setValueAtTime(0, startedAt + note.at);
    envelope.gain.linearRampToValueAtTime(gain, startedAt + note.at + 0.02);
    envelope.gain.linearRampToValueAtTime(0, startedAt + note.at + note.for);
    oscillator.connect(envelope);
    envelope.connect(audioContext.destination);
    oscillator.start(startedAt + note.at);
    oscillator.stop(startedAt + note.at + note.for);
  }
};

/**
 * Bring the context to `running`, reporting whether it got there. No sound.
 *
 * Split out from `unlock` because the two callers want different things: the control
 * plays a note so the person hears that it worked, while the automatic re-arm after a
 * reload must be silent — a beep triggered by an unrelated click, with nothing wrong,
 * teaches the opposite of what the sound means.
 */
const resume = async (): Promise<boolean> => {
  try {
    audioContext ??= contextFactory();
    if (audioContext.state === "suspended") await audioContext.resume();
    unlocked.value = audioContext.state === "running";
  } catch {
    // No Web Audio, or the gesture was not accepted. Reported, never silent.
    unlocked.value = false;
  }
  // Whatever was missed before is no longer the current state of affairs.
  if (unlocked.value) missedForGesture.value = false;
  return unlocked.value;
};

/**
 * While armed but not yet unlocked, let any gesture anywhere do the unlocking.
 *
 * `capture`, so a handler that stops propagation cannot swallow the gesture we need, and
 * both event types, because a keyboard operator may never produce a pointer event.
 *
 * Deliberately **not** `once`. It was, and that made the recovery path single-shot: if the
 * first click's `resume()` did not take (Chrome leaves the promise pending rather than
 * rejecting when the autoplay policy blocks it), there was no listener left for the
 * second. Now every gesture retries — `resume()` is idempotent and costs nothing when it
 * is already running — and the listener detaches itself the moment it succeeds, which is
 * the only condition under which it has nothing left to do.
 *
 * The detach function is kept at module scope so `__resetAlertSound` can remove a
 * listener that never fired; otherwise it would outlive its test and unlock a later one
 * from an unrelated click.
 */
let detachGesture: (() => void) | null = null;
/** One automatic attempt per document; see `attemptAutoResume`. */
let autoResumeAttempted = false;

const attachGestureListener = (): void => {
  if (detachGesture || typeof window === "undefined") return;

  const onGesture = (): void => {
    if (!armed.value || unlocked.value) {
      detachGesture?.();
      return;
    }
    void resume().then(() => {
      if (unlocked.value) detachGesture?.();
    });
  };

  detachGesture = () => {
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
    detachGesture = null;
  };

  window.addEventListener("pointerdown", onGesture, { capture: true });
  window.addEventListener("keydown", onGesture, { capture: true });
};

/**
 * On a reload of an armed browser, try to resume — **and arm the gesture path first**.
 *
 * 14A introduced the armed/unlocked split and the 待就绪 readout; 14E made this code
 * actually attempt the resume instead of only waiting for a click, because a gesture is
 * not always required (Chrome starts an `AudioContext` on a site the person uses
 * regularly, and a document with sticky activation always can). Reporting "waiting for a
 * click" without having asked is the same error as reporting a value nobody measured.
 *
 * 14E then got the *order* wrong, and that was a regression: it attached the gesture
 * listener inside `.then`. Chrome does not reject `resume()` when the autoplay policy
 * blocks it — **the promise simply never settles**, so the `.then` never ran and the
 * listener was never attached. Clicking anywhere stopped working; only the control
 * itself did. Reported as 待就绪 surviving every refresh, which is exactly what it
 * looks like from outside.
 *
 * So the listener goes on **unconditionally and first**, and the attempt is fire-and-
 * forget on top of it. Whichever wins, `unlocked` is set once and the other becomes a
 * no-op — the listener checks `armed && !unlocked`, and `resume()` is idempotent.
 *
 * Where the browser does insist on a gesture, 待就绪 is the truth and cannot be
 * engineered away: the alternative is a console that says it will beep and does not,
 * which is the one failure this module exists to prevent.
 */
const attemptAutoResume = (): void => {
  if (autoResumeAttempted || unlocked.value || !armed.value) return;
  autoResumeAttempted = true;
  attachGestureListener();
  void resume();
};

export const useAlertSound = () => {
  if (armed.value && !unlocked.value) attemptAutoResume();

  /**
   * Turn sound on. **Must be called from a user gesture** — that is the whole point
   * of the control that calls it. Plays once on success, so the person learns both
   * that it worked and how loud it is, and records the choice so the next load only
   * needs a gesture rather than another visit to this control.
   */
  const unlock = async (): Promise<boolean> => {
    const running = await resume();
    if (running) {
      armed.value = true;
      write(ARMED_KEY, "1", "session");
      play();
    }
    return running;
  };

  const canSound = computed(
    () =>
      unlocked.value &&
      !muted.value &&
      !isQuietAt(quietHours.value, new Date()),
  );

  /**
   * Given every currently-active critical alert id, sound if any of them is new.
   *
   * Returns whether it made a sound, which is what the tests assert on — and what a
   * caller would need if it ever wanted to log it.
   */
  const announce = (criticalIds: readonly string[]): boolean => {
    const current = new Set(criticalIds);

    if (!seeded) {
      // See decision 3: signing in to four existing criticals must be quiet.
      announcedIds = current;
      seeded = true;
      return false;
    }

    const fresh = criticalIds.filter((id) => !announcedIds.has(id));
    announcedIds = current;
    if (!fresh.length) return false;

    /*
     * The moment the optimistic reading stops being true.
     *
     * While armed, the control says 告警响应 before any gesture has happened — see
     * `silentReason`. That is a forecast, and this is the branch where the forecast fails:
     * a critical condition has arrived and the browser has still not let us start audio.
     * So record it (the readout switches to 待就绪 and goes amber) and try again, so the
     * *next* one is audible. `missed` is what the caller turns into a visible notice —
     * an alert that cannot be heard must at least not be invisible.
     */
    if (armed.value && !unlocked.value) {
      missedForGesture.value = true;
      void resume();
      return false;
    }

    // Muted / quiet still consumes the ids above: coming back from lunch should not
    // replay everything that happened while the room was quiet.
    if (!canSound.value) return false;

    const now = Date.now();
    if (now - lastSoundAt < SOUND_THROTTLE_MS) return false;
    lastSoundAt = now;

    play();
    return true;
  };

  /**
   * Mute and unmute.
   *
   * Unmuting plays the confirmation note, for the same reason `unlock` does: the person
   * has just asked for sound, and the one thing they cannot check for themselves is
   * whether the speaker actually works. Muting is silent — a beep to confirm silence
   * would be a joke at the operator's expense.
   */
  const setMuted = (next: boolean): void => {
    muted.value = next;
    write(MUTED_KEY, next ? "1" : "0");
    if (!next && unlocked.value) play();
  };

  const setVolume = (next: SoundVolume): void => {
    volume.value = next;
    write(VOLUME_KEY, next);
    if (unlocked.value && !muted.value) play();
  };

  const setQuietHours = (next: QuietHours): void => {
    quietHours.value = next;
    write(QUIET_KEY, next);
  };

  return {
    unlocked: readonly(unlocked),
    /** Whether this login session has deliberately enabled sound — see `areaOf`. */
    armed: readonly(armed),
    muted: readonly(muted),
    volume: readonly(volume),
    quietHours: readonly(quietHours),
    /**
     * Why the console is currently silent, for the control's own label.
     *
     * `pending` is the state a reload lands in when sound was enabled earlier: the
     * preference is intact and the browser is simply waiting for a gesture. Reporting
     * it as `locked` was read during 14A acceptance as the setting being forgotten.
     */
    /** True once a critical went unheard for want of a gesture; cleared on success. */
    missedForGesture: readonly(missedForGesture),
    silentReason: computed<"" | "locked" | "pending" | "muted" | "quiet">(
      () => {
        if (!unlocked.value) {
          if (!armed.value) return "locked";
          // Armed but not yet unlocked reports **响应**, not 待就绪.
          //
          // This is the third pass over this readout, so the reasoning is worth stating.
          // A reload always lands here: browsers refuse to start audio in a document that
          // has had no gesture, and nothing stored can change that. Reporting it made the
          // console say 待就绪 after every refresh, which acceptance read — correctly — as
          // the setting having been forgotten, because from the outside it is
          // indistinguishable from that.
          //
          // What makes 响应 honest rather than optimistic is the pair of things underneath
          // it: any interaction anywhere resumes the context silently, and if a critical
          // *does* arrive first, `announce` flips `missedForGesture` and this returns
          // `pending` at that moment — with a notice, from the caller. So the console
          // claims coverage while it has every reason to expect it, and stops claiming it
          // the instant it is proven wrong, rather than pre-emptively warning about a
          // window that almost never contains an alert.
          //
          // The exception is an unattended display, which reloads and is then touched by
          // nobody for hours. That case is not solvable in the page — see
          // `deploy/docs/deployment.md` for the browser flag that fixes it properly.
          return missedForGesture.value ? "pending" : "";
        }
        if (muted.value) return "muted";
        if (isQuietAt(quietHours.value, new Date())) return "quiet";
        return "";
      },
    ),
    unlock,
    announce,
    setMuted,
    setVolume,
    setQuietHours,
  };
};

export const ALERT_SOUND_KEYS = {
  muted: MUTED_KEY,
  volume: VOLUME_KEY,
  quiet: QUIET_KEY,
  armed: ARMED_KEY,
} as const;

/**
 * The login session has ended: put the sound back to "not enabled yet".
 *
 * Called from `App.vue` when the auth state leaves `authenticated`, which covers both a
 * deliberate 退出登录 and a session that expired underneath the operator. Without this,
 * arming was a property of the *browser* — the next person to sign in at a shared terminal
 * inherited an armed console they never asked for, and the readout had no way to ask them
 * for the one click it needs.
 *
 * Three things are reset beyond the flag itself:
 *
 * - **The gesture listener**, or a click meant for the login form would silently re-arm.
 * - **The seen set**, so the next session's first observation seeds instead of announcing.
 *   Signing back in to a fleet that is already in trouble must be as quiet as signing in
 *   for the first time; those conditions are on screen, not new.
 * - **The audio context**, closed rather than merely dropped, so `unlocked === false` is
 *   literally true and a signed-out console is not holding an audio device open.
 */
export const disarmAlertSound = (): void => {
  armed.value = false;
  unlocked.value = false;
  missedForGesture.value = false;
  autoResumeAttempted = false;
  detachGesture?.();
  try {
    areaOf("session").removeItem(ARMED_KEY);
  } catch {
    // Storage blocked; the in-memory flag is what the readout reads.
  }
  announcedIds = new Set();
  seeded = false;
  const closing = audioContext;
  audioContext = null;
  // Rejects on a context that is already closed, which is not a failure here.
  closing?.close().catch(() => undefined);
};

/** Test-only: module state would otherwise leak between files. */
export const __resetAlertSound = (): void => {
  muted.value = readStored(MUTED_KEY, ["0", "1"] as const, "0") === "1";
  volume.value = readStored(
    VOLUME_KEY,
    ["low", "medium", "high"] as const,
    "medium",
  );
  quietHours.value = readStored(
    QUIET_KEY,
    ["off", "all", "night"] as const,
    "off",
  );
  armed.value =
    readStored(ARMED_KEY, ["0", "1"] as const, "0", "session") === "1";
  missedForGesture.value = false;
  unlocked.value = false;
  audioContext = null;
  announcedIds = new Set();
  seeded = false;
  lastSoundAt = 0;
  autoResumeAttempted = false;
  // A listener that never fired is keyed to the window a previous test mounted into;
  // leaving it attached would unlock a later case from an unrelated click.
  detachGesture?.();
};

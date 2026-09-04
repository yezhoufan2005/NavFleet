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
 * - *Armed* is a preference, and persists. It means "this browser has enabled alert
 *   sound at least once, deliberately".
 * - *Unlocked* is a property of this document, and cannot persist.
 *
 * When armed, the next gesture anywhere on the page resumes the context — no second
 * trip to the control — and the readout says 声音待就绪 rather than 未启用 in between,
 * because "you turned this off" and "the browser is waiting for a click" are different
 * facts and only one of them is actionable. Arming is deliberately **not** the default:
 * a console that starts beeping at an operator who never asked for sound is the failure
 * mode that gets speakers unplugged.
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

const readStored = <T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  try {
    const stored = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(stored ?? "")
      ? (stored as T)
      : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
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
/** Persisted: whether this browser has ever deliberately enabled alert sound. */
const armed = ref(readStored(ARMED_KEY, ["0", "1"] as const, "0") === "1");
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
  return unlocked.value;
};

/**
 * While armed but not yet unlocked, let the next gesture anywhere do the unlocking.
 *
 * `capture` and `once`: capture so that a handler which stops propagation cannot
 * swallow the one gesture we need, and `once` so this costs nothing after it fires.
 * Both event types, because a keyboard operator may never produce a pointer event.
 *
 * The detach function is kept at module scope so `__resetAlertSound` can remove a
 * listener that never fired; otherwise it would outlive its test and unlock a later
 * one from an unrelated click.
 */
let detachGesture: (() => void) | null = null;
/** One automatic attempt per document; see `attemptAutoResume`. */
let autoResumeAttempted = false;

const attachGestureListener = (): void => {
  if (detachGesture || typeof window === "undefined") return;

  const onGesture = (): void => {
    detachGesture?.();
    if (armed.value && !unlocked.value) void resume();
  };

  detachGesture = () => {
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
    detachGesture = null;
  };

  window.addEventListener("pointerdown", onGesture, {
    capture: true,
    once: true,
  });
  window.addEventListener("keydown", onGesture, { capture: true, once: true });
};

/**
 * On a reload of an armed browser, **try to resume before reporting anything**.
 *
 * 14A introduced the armed/unlocked split and, with it, the 待就绪 readout. Acceptance
 * came back saying 待就绪 still shows on every refresh — and the reason it did was not
 * the browser: this code never *attempted* the resume, it only waited for a gesture. But
 * a gesture is not always required. Chrome will start an `AudioContext` on a site the
 * person uses regularly (media engagement), and any browser will on a document that
 * still has sticky activation. Reporting "waiting for a click" without having asked is
 * the same error as reporting a value nobody measured.
 *
 * So: ask once, and fall back to the gesture listener only when the answer is no. Where
 * the browser does insist, 待就绪 is the truth and cannot be engineered away — that is
 * why it wears the warning colour rather than the muted one, and why any click anywhere
 * still resolves it.
 */
const attemptAutoResume = (): void => {
  if (autoResumeAttempted || unlocked.value || !armed.value) return;
  autoResumeAttempted = true;
  void resume().then((running) => {
    if (!running) attachGestureListener();
  });
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
      write(ARMED_KEY, "1");
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

    // Muted / quiet / locked still consumes the ids above: coming back from lunch
    // should not replay everything that happened while the room was quiet.
    if (!canSound.value) return false;

    const now = Date.now();
    if (now - lastSoundAt < SOUND_THROTTLE_MS) return false;
    lastSoundAt = now;

    play();
    return true;
  };

  const setMuted = (next: boolean): void => {
    muted.value = next;
    write(MUTED_KEY, next ? "1" : "0");
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
    /** Whether this browser has deliberately enabled sound before — persisted. */
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
    silentReason: computed<"" | "locked" | "pending" | "muted" | "quiet">(
      () => {
        if (!unlocked.value) return armed.value ? "pending" : "locked";
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
  armed.value = readStored(ARMED_KEY, ["0", "1"] as const, "0") === "1";
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

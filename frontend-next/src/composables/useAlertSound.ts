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
export type QuietHours = "off" | "night";

const MUTED_KEY = "navfleet:alert-sound-muted";
const VOLUME_KEY = "navfleet:alert-sound-volume";
const QUIET_KEY = "navfleet:alert-sound-quiet";

/** Peak gain per setting. Deliberately well below 1 — this is a room, not headphones. */
const VOLUME_GAIN: Record<SoundVolume, number> = {
  low: 0.08,
  medium: 0.2,
  high: 0.45,
};

/** The one preset window. A free-form range needs a form; see the note in 13D-2. */
export const NIGHT_WINDOW = { fromHour: 22, toHour: 7 } as const;

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
  readStored(QUIET_KEY, ["off", "night"] as const, "off"),
);

/** Session-only: an unlock cannot outlive the page that performed the gesture. */
const unlocked = ref(false);
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
 */
export const isQuietAt = (setting: QuietHours, at: Date): boolean => {
  if (setting === "off") return false;
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

export const useAlertSound = () => {
  /**
   * Turn sound on. **Must be called from a user gesture** — that is the whole point
   * of the control that calls it. Plays once on success, so the person learns both
   * that it worked and how loud it is.
   */
  const unlock = async (): Promise<boolean> => {
    try {
      audioContext ??= contextFactory();
      if (audioContext.state === "suspended") await audioContext.resume();
      unlocked.value = audioContext.state === "running";
    } catch {
      // No Web Audio, or the gesture was not accepted. Reported, never silent.
      unlocked.value = false;
    }
    if (unlocked.value) play();
    return unlocked.value;
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
    muted: readonly(muted),
    volume: readonly(volume),
    quietHours: readonly(quietHours),
    canSound,
    /** Why the console is currently silent, for the control's own label. */
    silentReason: computed<"" | "locked" | "muted" | "quiet">(() => {
      if (!unlocked.value) return "locked";
      if (muted.value) return "muted";
      if (isQuietAt(quietHours.value, new Date())) return "quiet";
      return "";
    }),
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
} as const;

/** Test-only: module state would otherwise leak between files. */
export const __resetAlertSound = (): void => {
  muted.value = readStored(MUTED_KEY, ["0", "1"] as const, "0") === "1";
  volume.value = readStored(
    VOLUME_KEY,
    ["low", "medium", "high"] as const,
    "medium",
  );
  quietHours.value = readStored(QUIET_KEY, ["off", "night"] as const, "off");
  unlocked.value = false;
  audioContext = null;
  announcedIds = new Set();
  seeded = false;
  lastSoundAt = 0;
};

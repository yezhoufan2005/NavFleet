/**
 * The chart performance harness exposes its loader on `window` so the spec can drive
 * it without typing into inputs — fewer moving parts between the measurement and the
 * thing being measured. Declared here because the spec runs in its own tsconfig and
 * cannot see the console's `env.d.ts`.
 */
interface Window {
  __chartPerf?: {
    load: (seriesCount: number, pointsPer: number) => void;
  };
}

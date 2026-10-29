/**
 * The simulator's randomness: mulberry32, whose whole state is one 32-bit integer.
 *
 * That is the property the simulator needs. A vehicle's generator state is saved in every
 * checkpoint, so replaying from a checkpoint reproduces the same seconds exactly — which is what
 * lets the history backfill and the live publisher compute one timeline independently and agree
 * on every frame.
 */
export class Rng {
  constructor(private state: number) {}

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  between(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items[Math.floor(this.next() * items.length)];
  }

  /** The generator's whole state, for a checkpoint. */
  save(): number {
    return this.state;
  }
}

/** A stable 32-bit seed from a string (FNV-1a), so a vehicle's seed survives reordering the roster. */
export const seedOf = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

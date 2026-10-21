/**
 * The seeded random number generator.
 *
 * It lives in its own module because two things need it — the benchmark's
 * **schedule** and the **bootstrap** — and the schedule's module is a script
 * that runs the whole benchmark when it is imported.
 *
 * xorshift32: deterministic, fast, and adequate for both uses. Neither use
 * needs a cryptographic generator, and both need the *same* seed to give the
 * same sequence every time.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    // xorshift32
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

import { describe, expect, test } from "bun:test"
import { buildSchedule } from "../harness/run.ts"

/**
 * The schedule.
 *
 * The runs used to be scheduled in **arm blocks**: every run of one arm,
 * then every run of the next. That correlates the arm with the position in
 * the run, and the position in the run correlates with the provider's
 * cache state, its rate limit and its own load. A difference between two
 * arms could then be a difference in *when* they ran.
 *
 * The schedule is now a seeded randomisation, in blocks, so the arms are
 * balanced within every block.
 */

/** A small matrix. */
const MATRIX = {
  models: ["model-a", "model-b"],
  shapes: ["arm-1", "arm-2", "arm-3"],
  tasks: [{ id: "task-1" }, { id: "task-2" }],
  repeats: 3,
  block: 2,
}

describe("the schedule", () => {
  test("it runs every cell the right number of times", () => {
    const schedule = buildSchedule({ ...MATRIX, seed: 1 })
    expect(schedule.length).toBe(
      MATRIX.models.length * MATRIX.shapes.length * MATRIX.tasks.length * MATRIX.repeats,
    )
    const seen = new Map<string, number>()
    for (const entry of schedule) {
      const key = `${entry.model}|${entry.shape}|${entry.task}|${entry.repeat}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, count] of seen) {
      expect(`${key}:${count}`).toBe(`${key}:1`)
    }
  })

  test("the same seed gives the same schedule", () => {
    expect(buildSchedule({ ...MATRIX, seed: 42 })).toEqual(buildSchedule({ ...MATRIX, seed: 42 }))
  })

  test("a different seed gives a different schedule", () => {
    const a = buildSchedule({ ...MATRIX, seed: 1 })
    const b = buildSchedule({ ...MATRIX, seed: 2 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  test("it does not schedule in arm blocks", () => {
    // The defect this fixes: the arms came out in contiguous runs.
    // With the randomisation, an arm's first and second runs are not
    // adjacent for every arm.
    const schedule = buildSchedule({ ...MATRIX, seed: 7 })
    const shapeSequence = schedule.map(entry => entry.shape)
    // Count the number of times an arm's run follows a different arm.
    let transitions = 0
    for (let index = 1; index < shapeSequence.length; index++) {
      if (shapeSequence[index] !== shapeSequence[index - 1]) transitions++
    }
    // A blocked schedule would have at most (arms - 1) transitions per
    // repeat round. A randomised one has many more.
    expect(transitions).toBeGreaterThan(shapeSequence.length / 4)
  })

  test("every block is balanced across the arms", () => {
    // A block holds one run per cell per repeat, so within a block every
    // cell appears the same number of times. A provider hiccup that hits
    // one block therefore hits every arm in it.
    const schedule = buildSchedule({ ...MATRIX, seed: 11 })
    const cells = MATRIX.models.length * MATRIX.shapes.length * MATRIX.tasks.length
    const blocks = Math.ceil(MATRIX.repeats / MATRIX.block)
    for (let block = 0; block < blocks; block++) {
      const slice = schedule.slice(block * cells * MATRIX.block, (block + 1) * cells * MATRIX.block)
      const counts = new Map<string, number>()
      for (const entry of slice) {
        const key = `${entry.model}|${entry.shape}|${entry.task}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const values = [...counts.values()]
      // Every cell appears the same number of times in the block.
      expect(new Set(values).size).toBe(1)
      // Every cell is present.
      expect(counts.size).toBe(cells)
    }
  })

  test("the arms are interleaved, and much less so than a blocked schedule", () => {
    // The property that matters: a **blocked** schedule — every run of one
    // arm, then the next — puts almost every run next to another run of
    // the same arm, and so correlates the arm with the provider's state at
    // that moment. The randomised schedule does not.
    const cells = MATRIX.models.length * MATRIX.shapes.length * MATRIX.tasks.length
    /** The number of times a run follows a run of the same arm. */
    const adjacentSameArm = (shapes: string[]): number => {
      let count = 0
      for (let index = 1; index < shapes.length; index++) {
        if (shapes[index] === shapes[index - 1]) count++
      }
      return count
    }
    // The blocked schedule, for comparison.
    const blocked: string[] = []
    for (const shape of MATRIX.shapes) {
      for (let index = 0; index < cells; index++) blocked.push(shape)
    }
    const blockedCount = adjacentSameArm(blocked)
    // The randomised schedule.
    const schedule = buildSchedule({ ...MATRIX, seed: 11 })
    const randomisedCount = adjacentSameArm(schedule.map(entry => entry.shape))
    expect(blockedCount).toBeGreaterThan(blocked.length / 2)
    expect(randomisedCount).toBeLessThan(blockedCount / 2)
  })
})

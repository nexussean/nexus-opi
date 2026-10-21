import { watch, type FSWatcher } from "node:fs"
import { relative, resolve, sep } from "node:path"

/**
 * The filesystem watcher.
 *
 * OpenCode has no file-change event that fires (see ADR-0015), so the indexer
 * watches the project itself. `node:fs.watch` is used rather than `Bun.watch`:
 * Bun 1.4 has no `Bun.watch`.
 *
 * The watcher is a **hint**, not a source of truth. It says "something changed
 * here"; the content hash says whether anything an indexer cares about actually
 * did. A missed event is caught by the next reconciliation.
 */

export interface WatcherOptions {
  /** The project root. */
  root: string
  /**
   * Called with the paths that may have changed, as one batch.
   *
   * A batch, not one call per path: a burst of edits is one unit of work, and
   * the indexer re-reads a set of files, not a stream of them.
   */
  onChange: (paths: string[]) => void
  /**
   * How long to wait for more changes before reporting. Rapid edits produce a
   * burst of events, and re-indexing each one is wasted work.
   */
  debounceMs?: number
  /** Paths that are never reported. */
  ignore?: (path: string) => boolean
}

export interface Watcher {
  close(): void
  /** The paths waiting to be reported. */
  readonly pending: number
}

export class ProjectWatcher {
  #root: string
  #onChange: (paths: string[]) => void
  #debounceMs: number
  #ignore: (path: string) => boolean
  #watcher: FSWatcher | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #pending = new Set<string>()

  constructor(options: WatcherOptions) {
    this.#root = resolve(options.root)
    this.#onChange = options.onChange
    this.#debounceMs = options.debounceMs ?? 250
    this.#ignore = options.ignore ?? (() => false)
  }

  get pending(): number {
    return this.#pending.size
  }

  start(): void {
    if (this.#watcher) return
    try {
      this.#watcher = watch(
        this.#root,
        { recursive: true, persistent: false },
        (_event, filename) => {
          if (!filename) return
          const path = filename.toString().split(sep).join("/")
          if (this.#ignore(path)) return
          this.#pending.add(path)
          this.#schedule()
        },
      )
      this.#watcher.on("error", () => {
        // A watcher that dies is not fatal: the reconciliation still runs.
        this.#watcher = undefined
      })
    } catch {
      // Recursive watching is not available everywhere. The caller falls back
      // to periodic reconciliation.
      this.#watcher = undefined
    }
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      const paths = [...this.#pending]
      this.#pending.clear()
      if (paths.length === 0) return
      let reported: string[]
      try {
        reported = paths.map((path) =>
          relative(this.#root, resolve(this.#root, path)).split(sep).join("/"),
        )
      } catch {
        // A path that cannot be resolved is not reportable.
        return
      }
      this.#onChange(reported)
    }, this.#debounceMs)
    // The timer must not hold the process open.
    if (typeof this.#timer === "object" && "unref" in this.#timer) this.#timer.unref()
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending.clear()
    this.#watcher?.close()
    this.#watcher = undefined
  }
}

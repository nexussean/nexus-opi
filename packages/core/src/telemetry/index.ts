/**
 * Local metrics.
 *
 * Counters and histograms, kept in memory and never transmitted. Label sets are
 * **bounded**: a metric name has a cap on how many distinct label combinations
 * it will track. Without that, a label containing a path or an id would grow
 * the store without limit — the failure mode the plan's risk register calls
 * "cached context contains secret" and "huge graphs make UI unusable", in a
 * different costume.
 */

export type Labels = Readonly<Record<string, string>>

export interface Series {
  name: string
  labels: Labels
  value: number
}

export interface HistogramSeries {
  name: string
  labels: Labels
  count: number
  sum: number
  /** Upper bound of each bucket, in ascending order. */
  buckets: number[]
  /** Number of observations at or below each bucket bound. */
  counts: number[]
}

export interface MetricsSnapshot {
  counters: Series[]
  histograms: HistogramSeries[]
  /** Series dropped because a metric hit its cap. */
  dropped: number
}

export interface MetricsSinkOptions {
  /** Maximum distinct label combinations tracked per metric name. */
  maxSeriesPerMetric?: number
  /** Histogram bucket upper bounds, ascending. */
  buckets?: number[]
}

const DEFAULT_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]

function labelKey(name: string, labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
  return `${name}|${entries.map(([key, value]) => `${key}=${value}`).join(",")}`
}

export class MetricsSink {
  #counters = new Map<string, Series>()
  #histograms = new Map<string, HistogramSeries>()
  #seriesCount = new Map<string, number>()
  #dropped = 0
  #maxSeries: number
  #buckets: number[]

  constructor(options: MetricsSinkOptions = {}) {
    this.#maxSeries = options.maxSeriesPerMetric ?? 200
    this.#buckets = [...(options.buckets ?? DEFAULT_BUCKETS)].sort((a, b) => a - b)
  }

  get dropped(): number {
    return this.#dropped
  }

  #allow(name: string, key: string): boolean {
    const count = this.#seriesCount.get(name) ?? 0
    if (this.#counters.has(key) || this.#histograms.has(key)) return true
    if (count >= this.#maxSeries) {
      this.#dropped += 1
      return false
    }
    this.#seriesCount.set(name, count + 1)
    return true
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    const key = labelKey(name, labels)
    if (!this.#allow(name, key)) return
    const existing = this.#counters.get(key)
    if (existing) {
      existing.value += by
      return
    }
    this.#counters.set(key, { name, labels, value: by })
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = labelKey(name, labels)
    if (!this.#allow(name, key)) return
    let series = this.#histograms.get(key)
    if (!series) {
      series = {
        name,
        labels,
        count: 0,
        sum: 0,
        buckets: [...this.#buckets],
        counts: new Array(this.#buckets.length).fill(0),
      }
      this.#histograms.set(key, series)
    }
    series.count += 1
    series.sum += value
    for (let index = 0; index < series.buckets.length; index++) {
      if (value <= series.buckets[index]!) {
        series.counts[index] = (series.counts[index] ?? 0) + 1
        break
      }
    }
  }

  /** Time a block and record its duration in milliseconds. */
  async time<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      return await fn()
    } finally {
      this.observe(name, performance.now() - started, labels)
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.#counters.values()].map((series) => ({ ...series, labels: { ...series.labels } })),
      histograms: [...this.#histograms.values()].map((series) => ({
        ...series,
        labels: { ...series.labels },
        buckets: [...series.buckets],
        counts: [...series.counts],
      })),
      dropped: this.#dropped,
    }
  }

  reset(): void {
    this.#counters.clear()
    this.#histograms.clear()
    this.#seriesCount.clear()
    this.#dropped = 0
  }
}

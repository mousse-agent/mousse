import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { smoothPath, useWidth } from '../lib/usageCharts'

const PLOT_H = 236
/** The thinnest a non-empty band is drawn when stacked, so a series with a sliver of the total stays visible. */
const MIN_BAND = 2

export interface ChartSeries {
  id: string
  label: string
  color: string
  /** One value per bucket; null where there is none (the line breaks there). */
  values: ReadonlyArray<number | null>
}

export interface ChartScale {
  /** The scale's steps, lowest first; the last is its top. */
  ticks: readonly number[]
  format: (value: number) => string
}

/** Where things fall on the plot, for marks drawn over the areas. */
export interface ChartGeometry {
  width: number
  height: number
  /** The middle of a bucket. */
  xAt: (index: number) => number
  /** A share (0–1) of the way across the plot. */
  xOfShare: (share: number) => number
  /** A value on the left-hand scale. */
  yOf: (value: number) => number
}

export interface ChartTip {
  head: ReactNode
  rows: Array<{ key: string; color: string; name: string; cells: ReactNode }>
  /** Said when there are no rows. */
  empty?: string
}

/**
 * The usage chart, shared by the history and the limit trends: smooth areas over a soft gradient, either stacked
 * (biggest series at the bottom, each at least a hairline thick) or overlaid, with an optional thin line on a
 * right-hand scale. Hovering shows the bucket in a small card beside it, on the side with more room.
 */
export function UsageAreaChart({ count, series, stacked, scale, line, tipAt, xLabel, readout, ariaLabel, overlay }: {
  count: number
  series: readonly ChartSeries[]
  stacked: boolean
  scale: ChartScale
  /** A thin line read on the right-hand scale (the history's cost). */
  line?: { values: readonly number[]; scale: ChartScale }
  tipAt: (index: number) => ChartTip
  /** The label under a bucket: the first, middle and last are shown. */
  xLabel: (index: number) => string
  readout: ReactNode
  ariaLabel: string
  /** Faint marks drawn over the areas and under their edges. */
  overlay?: (geometry: ChartGeometry) => ReactNode
}) {
  const gradientId = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const width = useWidth(plotRef)
  const top = scale.ticks[scale.ticks.length - 1] || 1
  const lineTop = line ? line.scale.ticks[line.scale.ticks.length - 1] || 1 : 1
  const slot = width / Math.max(count, 1)
  const xAt = (i: number) => (i + 0.5) * slot
  const yOf = (pixels: number) => PLOT_H - pixels
  const yOfValue = (value: number) => yOf((Math.max(0, value) / top) * PLOT_H)
  const labelAt = [0, Math.floor((count - 1) / 2), count - 1]
  const onMove = (event: MouseEvent) => {
    const box = plotRef.current?.getBoundingClientRect()
    if (!box) return
    const index = Math.floor(((event.clientX - box.left) / box.width) * count)
    setHover(index >= 0 && index < count ? index : null)
  }

  // Each series' fill (upper edge, then lower edge back) and its upper edge, run by run between gaps.
  const layers: Array<{ series: ChartSeries; runs: Array<{ upper: Array<readonly [number, number]>; lower: Array<readonly [number, number]> }> }> = []
  if (width > 0 && stacked) {
    // Stacked heights in pixels, each band at least MIN_BAND where it has a value; the stack is fitted back into the plot.
    const stacks = Array.from({ length: count }, (_, i) => {
      let base = 0
      return series.map((entry) => {
        const value = entry.values[i] ?? 0
        const height = value > 0 ? Math.max((value / top) * PLOT_H, MIN_BAND) : 0
        const band = { from: base, to: base + height }
        base += height
        return band
      })
    })
    const stackTop = Math.max(PLOT_H, ...stacks.map((bands) => bands[bands.length - 1]?.to ?? 0))
    const fit = stackTop > PLOT_H ? PLOT_H / stackTop : 1
    series.forEach((entry, a) => layers.push({
      series: entry,
      runs: [{
        upper: stacks.map((bands, i) => [xAt(i), yOf(bands[a]!.to * fit)] as const),
        lower: stacks.map((bands, i) => [xAt(i), yOf(bands[a]!.from * fit)] as const).reverse()
      }]
    }))
  } else if (width > 0) {
    for (const entry of series) {
      const runs: Array<{ upper: Array<readonly [number, number]>; lower: Array<readonly [number, number]> }> = []
      let run: Array<readonly [number, number]> = []
      const close = () => {
        if (run.length) runs.push({ upper: run, lower: [[run[run.length - 1]![0], PLOT_H], [run[0]![0], PLOT_H]] })
        run = []
      }
      for (let i = 0; i < count; i++) {
        const value = entry.values[i]
        if (value === null || value === undefined) close()
        else run.push([xAt(i), yOfValue(value)])
      }
      close()
      layers.push({ series: entry, runs })
    }
  }
  const linePath = width > 0 && line && series.length > 0 ? smoothPath(line.values.map((value, i) => [xAt(i), yOf((value / lineTop) * PLOT_H)] as const)) : ''
  const tip = hover === null ? null : { side: xAt(hover) > width / 2 ? 'left' as const : 'right' as const, x: xAt(hover), ...tipAt(hover) }
  const tickY = (tick: number) => `${(1 - tick / top) * 100}%`
  const lineTickY = (tick: number) => `${(1 - tick / lineTop) * 100}%`

  return <div className="usage-history-chart">
    <div className="usage-history-plot-row">
      <div className="usage-history-axis" aria-hidden="true">
        {[...scale.ticks].reverse().map((tick) => <span key={tick} style={{ top: tickY(tick) }}>{scale.format(tick)}</span>)}
      </div>
      <div className="usage-history-plot" ref={plotRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={ariaLabel}>
        {scale.ticks.map((tick) => <span key={tick} className="usage-history-grid" style={{ top: tickY(tick) }} />)}
        {width > 0 && <svg width={width} height={PLOT_H} viewBox={`0 0 ${width} ${PLOT_H}`}>
          <defs>
            {series.map((entry) => <linearGradient key={entry.id} id={`${gradientId}-${entry.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: entry.color, stopOpacity: 0.5 }} />
              <stop offset="100%" style={{ stopColor: entry.color, stopOpacity: 0.14 }} />
            </linearGradient>)}
          </defs>
          {hover !== null && <line className="usage-history-guide" x1={xAt(hover)} x2={xAt(hover)} y1={0} y2={PLOT_H} />}
          {layers.flatMap(({ series: entry, runs }) => runs.map(({ upper, lower }, r) => <path key={`f-${entry.id}-${r}`}
            d={`${smoothPath(upper)} ${stacked ? smoothPath(lower, false) : `L${lower[0]![0]},${lower[0]![1]} L${lower[1]![0]},${lower[1]![1]}`} Z`} fill={`url(#${gradientId}-${entry.id})`} />))}
          {overlay?.({ width, height: PLOT_H, xAt, xOfShare: (share) => share * width, yOf: yOfValue })}
          {/* Edges top layer last, so a small series reads as a thin coloured rim. */}
          {[...layers].reverse().flatMap(({ series: entry, runs }, n) => runs.map(({ upper }, r) => <path key={`s-${entry.id}-${r}`} d={smoothPath(upper)} fill="none" stroke={entry.color}
            strokeWidth={stacked && n === layers.length - 1 ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" />))}
          {linePath && <path className="usage-history-cost-line" d={linePath} fill="none" strokeLinejoin="round" strokeLinecap="round" />}
          {linePath && hover !== null && <circle className="usage-history-cost-dot" cx={xAt(hover)} cy={yOf(((line!.values[hover] ?? 0) / lineTop) * PLOT_H)} r={3} />}
          {!stacked && hover !== null && series.map((entry) => {
            const value = entry.values[hover]
            return value === null || value === undefined ? null : <circle key={`d-${entry.id}`} className="usage-history-dot" cx={xAt(hover)} cy={yOfValue(value)} r={3} fill={entry.color} />
          })}
        </svg>}
        {tip && <div className="usage-history-tip" data-side={tip.side} style={{ left: tip.x }} aria-hidden="true">
          <div className="usage-history-tip-head">{tip.head}</div>
          {tip.rows.length === 0 && <div className="usage-history-tip-row settings-muted">{tip.empty ?? 'Nothing'}</div>}
          {tip.rows.map((row) => <div key={row.key} className="usage-history-tip-row">
            <span className="usage-history-tip-key" style={{ background: row.color }} />
            <span className="usage-history-tip-name">{row.name}</span>
            {row.cells}
          </div>)}
        </div>}
      </div>
      {line && <div className="usage-history-axis is-cost" aria-hidden="true">
        {[...line.scale.ticks].reverse().map((tick) => <span key={tick} style={{ top: lineTickY(tick) }}>{line.scale.format(tick)}</span>)}
      </div>}
    </div>
    <div className="usage-history-x" aria-hidden="true">
      {labelAt.map((index, n) => <span key={n} style={{ left: `${((index + 0.5) / count) * 100}%` }}>{xLabel(index)}</span>)}
    </div>
    <p className="usage-history-readout">{readout}</p>
  </div>
}

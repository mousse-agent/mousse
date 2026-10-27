import type { UsageGroup } from '../../../shared/storage'

const SIZE = 148
const STROKE = 20
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** A thin gap between neighbouring arcs so they stay apart in both themes. */
const GAP = 1.5

/** The six categorical hues; a seventh slice reuses the first. "Other" is always the quiet grey. */
export function sliceColor(group: UsageGroup, index: number): string {
  const other = group.kind === 'other' || (group.kind === undefined && !group.id)
  return other ? 'var(--text-secondary)' : `var(--hue-${(index % 6) + 1})`
}

/** Arc lengths (in SVG units) for the groups, in order. Pure, so the chart and its tests share it. */
export function sliceArcs(groups: readonly UsageGroup[]): Array<{ key: string; offset: number; length: number }> {
  let offset = 0
  return groups.map((group) => {
    const span = group.share * CIRCUMFERENCE
    const arc = { key: group.key, offset, length: Math.max(0, span - (groups.length > 1 && span > GAP * 2 ? GAP : 0)) }
    offset += span
    return arc
  })
}

/**
 * A donut drawn as stroked circle arcs, the way the app's other gauges are. It is decoration: the
 * legend and the table beside it carry every number, so the picture is hidden from assistive tech.
 */
export function StorageDonut({ groups }: { groups: readonly UsageGroup[] }) {
  const arcs = sliceArcs(groups)
  return <svg className="storage-donut" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" data-testid="storage-donut">
    <circle className="storage-donut-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} />
    {groups.map((group, index) => {
      const arc = arcs[index]!
      if (arc.length <= 0) return null
      return <circle
        key={group.key}
        className="storage-donut-arc"
        data-testid="storage-donut-arc"
        data-key={group.key}
        data-length={arc.length.toFixed(2)}
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        strokeWidth={STROKE}
        stroke={sliceColor(group, index)}
        strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
        strokeDashoffset={-arc.offset}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    })}
  </svg>
}

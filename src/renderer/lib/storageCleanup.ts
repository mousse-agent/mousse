import { formatBytes, type StorageCleanupItem, type StorageCleanupPlanItem } from '../../shared/storage'

export interface PlanSummary {
  remove: number
  keep: number
  bytes: number
  approximate: boolean
  lowerBound: boolean
  /** Some removal empties the trash, which cannot be undone. */
  emptiesTrash: boolean
  line: string
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The sentence on top of the confirmation: what would go and how much space it frees. */
export function summarizePlan(plan: readonly StorageCleanupPlanItem[]): PlanSummary {
  const removals = plan.filter((item) => item.action === 'remove')
  const bytes = removals.reduce((sum, item) => sum + item.bytes, 0)
  const approximate = removals.some((item) => item.bytesApproximate)
  const lowerBound = approximate && removals.filter((item) => item.bytesApproximate).every((item) => item.bytesLowerBound)
  const keep = plan.length - removals.length
  const emptiesTrash = removals.some((item) => item.rule === 'trash')
  let line: string
  if (removals.length === 0) line = 'Nothing would be removed.'
  else {
    const size = bytes === 0 ? '' : lowerBound ? `, freeing at least ${formatBytes(bytes)}` : approximate ? `, freeing about ${formatBytes(bytes)}` : `, freeing ${formatBytes(bytes)}`
    line = `Would remove ${plural(removals.length, 'item')}${size}.`
  }
  return { remove: removals.length, keep, bytes, approximate, lowerBound, emptiesTrash, line }
}

const OUTCOME_ORDER: Record<StorageCleanupItem['outcome'], number> = { failed: 0, removed: 1, kept: 2 }

/** Failed first, then removed, then kept; the daemon already sorts, and this keeps the page right if it does not. */
export function orderReportItems(items: readonly StorageCleanupItem[]): StorageCleanupItem[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => OUTCOME_ORDER[a.item.outcome] - OUTCOME_ORDER[b.item.outcome] || a.index - b.index).map(({ item }) => item)
}

/** "1.2 GB", "about 1.2 GB" or "at least 1.2 GB" for an item; empty when it holds nothing. */
export function itemSize(item: Pick<StorageCleanupItem, 'bytes' | 'bytesApproximate' | 'bytesLowerBound'>): string {
  if (item.bytes <= 0) return ''
  const size = formatBytes(item.bytes)
  return item.bytesLowerBound ? `at least ${size}` : item.bytesApproximate ? `about ${size}` : size
}

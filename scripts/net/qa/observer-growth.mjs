const HOUR = 3600000

export const OBSERVER_INDEX = 3
export const MEMBER_NAMES = ['a', 'b', 'c', 'observer']
export const LIMITS = {
  // Allow normal V8 settling while rejecting sustained growth above 4 MiB/hour.
  rssKiBPerHour: 4096,
  // Keep every daemon below the existing 1 GiB process budget.
  rssKiB: 1024 * 1024,
  // Reject a large retained-memory jump even if a long run dilutes its slope.
  rssGrowthKiB: 128 * 1024,
  // Bound OS handle consumption independently of sampled growth.
  fd: 1024,
  // Allow connection churn but reject more than 32 retained handles.
  fdGrowth: 32,
  // Bound all persisted profile data, including SQLite and logs.
  diskKiB: 512 * 1024,
  // Allow the deliberately retained conversation while bounding excess disk growth.
  diskGrowthKiB: 64 * 1024,
  // Bound the total unresolved outbox rather than each state separately.
  queue: 128,
  // Allow a small transient backlog but reject accumulating unresolved work.
  queueGrowth: 8
}

export function growthPolicy(durationMs) {
  const qualification = durationMs >= 24 * HOUR
  return {
    warmupMs: qualification ? HOUR : Math.floor(durationMs / 5),
    windowMs: qualification ? HOUR : Math.floor(durationMs / 5),
    minSamples: qualification ? 30 : 3,
    enforceRssSlope: qualification,
    limits: LIMITS
  }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function evaluateGrowth(samples, policy, endMs) {
  const early = samples.filter(s => s.elapsedMs >= policy.warmupMs &&
    s.elapsedMs < policy.warmupMs + policy.windowMs)
  const lateStartMs = endMs - policy.windowMs
  const late = samples.filter(s => s.elapsedMs >= lateStartMs && s.elapsedMs <= endMs)
  const failures = []
  if (lateStartMs < policy.warmupMs + policy.windowMs ||
      early.length < policy.minSamples || late.length < policy.minSamples) {
    return { passed: false, failures: ['Insufficient disjoint observer growth windows'],
      earlySamples: early.length, lateSamples: late.length }
  }
  const summary = rows => Object.fromEntries(
    ['elapsedMs', 'rssKiB', 'fd', 'diskKiB', 'queue'].map(key => [key, median(rows.map(row => row[key]))])
  )
  const earlyMedian = summary(early)
  const lateMedian = summary(late)
  const growth = Object.fromEntries(['rssKiB', 'fd', 'diskKiB', 'queue'].map(key =>
    [key, lateMedian[key] - earlyMedian[key]]))
  const rssKiBPerHour = growth.rssKiB / ((lateMedian.elapsedMs - earlyMedian.elapsedMs) / HOUR)
  for (const key of ['rssKiB', 'fd', 'diskKiB', 'queue']) {
    if (samples.some(sample => sample[key] > policy.limits[key])) failures.push(key + ' ceiling exceeded')
    const growthKey = { rssKiB: 'rssGrowthKiB', fd: 'fdGrowth', diskKiB: 'diskGrowthKiB', queue: 'queueGrowth' }[key]
    if (growth[key] > policy.limits[growthKey]) failures.push(key + ' median growth exceeded')
  }
  if (policy.enforceRssSlope && rssKiBPerHour > policy.limits.rssKiBPerHour) {
    failures.push('RSS slope exceeded')
  }
  return { passed: failures.length === 0, failures, earlySamples: early.length, lateSamples: late.length,
    earlyMedian, lateMedian, growth, rssKiBPerHour, rssSlopeEnforced: policy.enforceRssSlope }
}

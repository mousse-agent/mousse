#!/usr/bin/env node
/**
 * What bot turns cost, from `bots.db` (`bot_turn_usage`, docs/plans/bot-context.md phase 0). Read-only.
 *
 *   node scripts/bot-turn-usage.mjs <profile home or bots.db> [--days 7] [--bot <id>] [--json]
 *
 * Per runtime and lane: turns, input a turn (fresh input, cache reads and writes together), the share read from the
 * cache, the prompt a turn last sent, the "hello" size (the smallest prompt a fresh-context turn sent: system text,
 * tools and pack before any chat), the Mousse tool list and system text sizes, the gaps between requests, compactions,
 * and the latest plan usage the runtime reported. No message text is read.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const target = args.find((arg, index) => !arg.startsWith('--') && !['--days', '--bot'].includes(args[index - 1]))
if (!target) {
  console.error('usage: node scripts/bot-turn-usage.mjs <profile home or bots.db> [--days 7] [--bot <id>] [--json]')
  process.exit(2)
}
const file = existsSync(target) && statSync(target).isDirectory() ? join(target, 'bots', 'bots.db') : target
if (!existsSync(file)) {
  console.error(`no bots.db at ${file}`)
  process.exit(2)
}
const days = Number(flag('--days') ?? 7)
const bot = flag('--bot')
const db = new DatabaseSync(file, { readOnly: true })
const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_turn_usage'").get()
if (!hasTable) {
  console.error('this bots.db has no bot_turn_usage table yet (a Mousse build before phase 0)')
  process.exit(1)
}
const since = Date.now() - days * 24 * 60 * 60_000
const rows = db.prepare(`SELECT * FROM bot_turn_usage WHERE started_at >= ? AND reports > 0 ${bot ? 'AND bot_id = ?' : ''} ORDER BY started_at`)
  .all(...(bot ? [since, bot] : [since]))
db.close()

const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
const runtimeOf = (row) => `${String(row.instance_id ?? '?').split(':')[0]} · ${row.model ?? '?'}`
const groups = new Map()
for (const row of rows) {
  const key = `${row.lane} | ${runtimeOf(row)}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
}
const report = [...groups].map(([key, list]) => {
  const sent = list.map((row) => row.input + row.cache_read + row.cache_write)
  const total = sent.reduce((sum, value) => sum + value, 0)
  const read = list.reduce((sum, row) => sum + row.cache_read, 0)
  const gaps = list.map((row) => row.gap_ms).filter((gap) => typeof gap === 'number')
  const fresh = list.filter((row) => row.fresh_context === 1 && typeof row.last_prompt === 'number')
  const latestQuota = [...list].reverse().find((row) => row.quota_json)?.quota_json
  const starts = {}
  for (const row of list) starts[row.started_by] = (starts[row.started_by] ?? 0) + 1
  return {
    group: key,
    turns: list.length,
    startedBy: starts,
    inputPerTurn: Math.round(total / list.length),
    medianInputPerTurn: median(sent),
    outputPerTurn: Math.round(list.reduce((sum, row) => sum + row.output, 0) / list.length),
    cachedShare: total ? Math.round((read / total) * 1000) / 1000 : 0,
    medianLastPrompt: median(list.map((row) => row.last_prompt)),
    maxLastPrompt: Math.max(0, ...list.map((row) => row.last_prompt ?? 0)),
    helloPrompt: fresh.length ? Math.min(...fresh.map((row) => row.last_prompt)) : null,
    mousseTools: median(list.map((row) => row.tools)),
    mousseToolChars: median(list.map((row) => row.tools_chars)),
    systemChars: median(list.map((row) => row.system_chars)),
    preambleChars: median(list.map((row) => row.preamble_chars)),
    gaps: gaps.length ? {
      count: gaps.length,
      median: median(gaps),
      under5m: Math.round((gaps.filter((gap) => gap < 5 * 60_000).length / gaps.length) * 1000) / 1000,
      under1h: Math.round((gaps.filter((gap) => gap < 60 * 60_000).length / gaps.length) * 1000) / 1000
    } : null,
    cacheTtlMs: median(list.map((row) => row.cache_ttl_ms)),
    contextWindow: median(list.map((row) => row.context_window)),
    compactions: list.reduce((sum, row) => sum + row.compactions, 0),
    contexts: new Set(list.map((row) => row.context_gen)).size,
    quota: latestQuota ? JSON.parse(latestQuota) : null
  }
})

if (args.includes('--json')) {
  console.log(JSON.stringify({ file, days, turns: rows.length, groups: report }, null, 2))
} else {
  console.log(`${rows.length} turns in the last ${days} days (${file})`)
  for (const group of report) {
    console.log(`\n${group.group}`)
    for (const [key, value] of Object.entries(group)) if (key !== 'group') console.log(`  ${key}: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : value}`)
  }
}

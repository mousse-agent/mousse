import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import {
  USAGE_AGENT_LABELS,
  type UsageAgentId, type UsageHistoryAgent, type UsageHistoryModelRow, type UsageHistoryRequest,
  type UsageHistoryResponse, type UsageHistorySource, type UsageProjectRow, type UsageSessionRow, type UsageTokens
} from '../../shared/usageHistory'
import { LOG_SOURCES, openCodeRoots, type LineParser, type LogRecord, type LogSource } from './logParsers'
import { costOf, priceFor } from './pricing'

const DAY = 86_400_000
/** How far back logs are read and kept, whatever range is shown. */
const KEEP_MS = 92 * DAY
const CACHE_VERSION = 2
const CHUNK = 1 << 20
const READ_CONCURRENCY = 4
const STAT_CONCURRENCY = 32

/**
 * A record as the cache keeps it: [time, model index, session index, input, cache read, cache write, output, key,
 * cost?, speed?, folder index?], where speed is 1 for standard and 2 for fast mode. Unknown ones are null, and
 * trailing unknown ones are left off.
 */
type Packed = [number, number, number, number, number, number, number, string, (number | null)?, (number | null)?, (number | null)?]

interface FileEntry {
  agent: UsageAgentId
  size: number
  mtimeMs: number
  /** Where the next read starts: just after the last complete line. */
  offset: number
  /** A hash of the bytes before `offset`, so a rewritten file is read again from the start. */
  guard: string
  state: unknown
  models: string[]
  sessions: string[]
  /** The folders the agent worked in, for the projects. */
  cwds: string[]
  recs: Packed[]
}

interface CacheFile {
  version: number
  files: Record<string, FileEntry>
}

interface ScanResult {
  entries: Array<[string, FileEntry]>
  sources: UsageHistorySource[]
  scanMs: number
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve))

async function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!)
  }))
}

function pack(entry: FileEntry, record: LogRecord): Packed {
  let model = entry.models.indexOf(record.model)
  if (model < 0) model = entry.models.push(record.model) - 1
  let session = entry.sessions.indexOf(record.session)
  if (session < 0) session = entry.sessions.push(record.session) - 1
  let cwd: number | null = null
  if (record.cwd) {
    cwd = entry.cwds.indexOf(record.cwd)
    if (cwd < 0) cwd = entry.cwds.push(record.cwd) - 1
  }
  const tail = [record.costUsd ?? null, record.speed ? (record.speed === 'fast' ? 2 : 1) : null, cwd]
  while (tail.length && tail[tail.length - 1] === null) tail.pop()
  return [record.ts, model, session, record.input, record.cacheRead, record.cacheWrite, record.output, record.key, ...tail] as Packed
}

async function guardOf(path: string, offset: number): Promise<string> {
  if (offset === 0) return ''
  const handle = await open(path, 'r')
  try {
    const length = Math.min(64, offset)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, offset - length)
    return createHash('sha1').update(buffer).digest('hex').slice(0, 16)
  } finally {
    await handle.close()
  }
}

/**
 * Reads a JSONL log from `entry.offset` to its last complete line, decoding only lines that hold
 * one of the parser's markers. A line still being written is left for the next read.
 */
async function readLines(path: string, entry: FileEntry, parser: LineParser, floor: number, sessionCwds?: ReadonlyMap<string, string>): Promise<void> {
  const markers = parser.markers.map((marker) => Buffer.from(marker))
  const handle = await open(path, 'r')
  let position = entry.offset
  let carry: Buffer | null = null
  let lastYield = Date.now()
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(CHUNK)
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position)
      if (bytesRead === 0) break
      position += bytesRead
      const data: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const dataStart = position - data.length
      const next = markers.map(() => -2)
      let start = 0
      for (;;) {
        const end = data.indexOf(10, start)
        if (end < 0) break
        let match = false
        for (let i = 0; i < markers.length && !match; i++) {
          if (next[i]! !== -1 && next[i]! < start) next[i] = data.indexOf(markers[i]!, start)
          if (next[i]! !== -1 && next[i]! < end) match = true
        }
        if (match) {
          try {
            const found = parser.parse(data.toString('utf8', start, end), entry.state, path)
            for (const record of Array.isArray(found) ? found : found ? [found] : []) {
              if (record.ts >= floor) {
                if (!record.cwd && sessionCwds) {
                  const cwd = sessionCwds.get(record.session)
                  if (cwd) record.cwd = cwd
                }
                entry.recs.push(pack(entry, record))
              }
            }
          } catch {
            // A malformed line is skipped.
          }
        }
        start = end + 1
      }
      entry.offset = dataStart + start
      carry = start < data.length ? Buffer.from(data.subarray(start)) : null
      if (Date.now() - lastYield > 8) { await yieldNow(); lastYield = Date.now() }
    }
  } finally {
    await handle.close()
  }
}

async function listFiles(root: string, accepts: (path: string) => boolean): Promise<string[]> {
  try {
    const dirents = await readdir(root, { recursive: true, withFileTypes: true })
    return dirents.filter((dirent) => dirent.isFile()).map((dirent) => join(dirent.parentPath, dirent.name)).filter(accepts)
  } catch {
    return []
  }
}

/** Antigravity keeps each conversation's transcript at a fixed path under `brain/<id>`, avoiding walking artifacts and chunks. */
async function listAntigravityTranscripts(root: string): Promise<string[]> {
  try {
    const dirents = await readdir(root, { withFileTypes: true })
    const files: string[] = []
    for (const dirent of dirents) {
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
      const transcript = join(root, dirent.name, '.system_generated', 'logs', 'transcript.jsonl')
      if (existsSync(transcript)) files.push(transcript)
    }
    return files
  } catch {
    return []
  }
}

function firstWorkspacePath(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    for (const entry of parsed) {
      if (typeof entry !== 'string' || !entry) continue
      if (entry.startsWith('file://')) {
        try { return fileURLToPath(entry) } catch { continue }
      }
      return entry
    }
  } catch {
    // Malformed workspace_uris leave the session without a folder.
  }
  return undefined
}

/** Reads `conversation_summaries.db` beside each Antigravity `brain` root to map session ids to their primary workspace folder. */
async function loadAntigravityCwds(brainRoots: readonly string[]): Promise<Map<string, string>> {
  const cwds = new Map<string, string>()
  for (const root of brainRoots) {
    const dbPath = join(dirname(root), 'conversation_summaries.db')
    if (!existsSync(dbPath)) continue
    try {
      const database = await openReadOnly(dbPath, 'SELECT 1 FROM conversation_summaries LIMIT 1')
      try {
        const rows = database
          .prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE workspace_uris != ''")
          .all() as Array<{ conversation_id: string; workspace_uris: string }>
        for (const row of rows) {
          if (!row.conversation_id || cwds.has(row.conversation_id)) continue
          const cwd = firstWorkspacePath(row.workspace_uris)
          if (cwd) cwds.set(row.conversation_id, cwd)
        }
      } finally {
        database.close()
      }
    } catch {
      // Missing or unreadable summaries leave sessions unattributed without failing the scan.
    }
  }
  return cwds
}

/**
 * Reads the coding agents' own local session logs into usage history. What it read is kept in a
 * cache file with each log's size, time and read position: an unchanged log is not read again, a
 * grown one is read from where the last read stopped, and a rewritten one from the start.
 */
export class UsageHistoryScanner {
  private cache: CacheFile | null = null
  private running: Promise<ScanResult> | null = null
  private dirty = false

  constructor(private readonly cachePath: string, private readonly now: () => number = Date.now) {}

  async history(request: UsageHistoryRequest): Promise<UsageHistoryResponse> {
    // Pages opened together share one scan.
    this.running ??= this.scan().finally(() => { this.running = null })
    const result = await this.running
    return aggregate(result, request, this.now())
  }

  private async loadCache(): Promise<CacheFile> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, 'utf8')) as CacheFile
      this.cache = parsed.version === CACHE_VERSION && parsed.files ? parsed : { version: CACHE_VERSION, files: {} }
    } catch {
      this.cache = { version: CACHE_VERSION, files: {} }
    }
    return this.cache
  }

  private async saveCache(): Promise<void> {
    if (!this.dirty || !this.cache) return
    this.dirty = false
    const floor = this.now() - KEEP_MS
    for (const [path, entry] of Object.entries(this.cache.files)) {
      if (entry.mtimeMs < floor) delete this.cache.files[path]
      else if (entry.recs.length && entry.recs[0]![0] < floor) entry.recs = entry.recs.filter((rec) => rec[0] >= floor)
    }
    await mkdir(dirname(this.cachePath), { recursive: true })
    const temp = `${this.cachePath}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.cache))
    await rename(temp, this.cachePath)
  }

  private async scan(): Promise<ScanResult> {
    const started = this.now()
    const cache = await this.loadCache()
    const floor = started - KEEP_MS
    const seen = new Set<string>()
    const sources: UsageHistorySource[] = []
    for (const source of LOG_SOURCES) sources.push(await this.scanSource(source, cache, floor, seen))
    sources.push(await this.scanOpenCode(cache, floor, seen))
    // A log the agent deleted keeps counting while it is within the kept window, but only while its
    // folder is still one we read: a moved agent folder or another home drops the old entries.
    const roots = [...LOG_SOURCES.flatMap((source) => source.roots()), ...openCodeRoots()].map((root) => resolve(root) + sep)
    for (const [path, entry] of Object.entries(cache.files)) {
      if (seen.has(path)) continue
      if (entry.mtimeMs < floor || !roots.some((root) => resolve(path).startsWith(root))) { delete cache.files[path]; this.dirty = true }
    }
    void this.saveCache().catch(() => { this.dirty = true })
    const entries = Object.entries(cache.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return { entries, sources, scanMs: this.now() - started }
  }

  private async scanSource(source: LogSource, cache: CacheFile, floor: number, seen: Set<string>): Promise<UsageHistorySource> {
    const roots = [...new Set(source.roots().map((root) => resolve(root)))]
    const found = roots.filter((root) => existsSync(root))
    const report: UsageHistorySource = { agent: source.agent, path: found[0] ?? roots[0] ?? '', status: found.length ? 'read' : 'missing', files: 0, readFiles: 0 }
    const files = (await Promise.all(found.map((root) => (source.agent === 'antigravity' ? listAntigravityTranscripts(root) : listFiles(root, source.accepts))))).flat()
    const work: Array<{ path: string; size: number; mtimeMs: number }> = []
    await mapLimit(files, STAT_CONCURRENCY, async (path) => {
      try {
        const info = await stat(path)
        if (info.mtimeMs < floor) return
        seen.add(path)
        work.push({ path, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // Gone between the listing and now.
      }
    })
    report.files = work.length
    const toRead = work.filter(({ path, size, mtimeMs }) => {
      const cached = cache.files[path]
      return !(cached && cached.size === size && cached.mtimeMs === mtimeMs)
    })
    const sessionCwds = toRead.length && source.agent === 'antigravity' ? await loadAntigravityCwds(found) : undefined
    await mapLimit(toRead, READ_CONCURRENCY, async ({ path, size, mtimeMs }) => {
      const cached = cache.files[path]
      try {
        let entry: FileEntry
        if (cached && size > cached.size && cached.offset > 0 && (await guardOf(path, cached.offset)) === cached.guard) {
          entry = { ...cached, recs: [...cached.recs], models: [...cached.models], sessions: [...cached.sessions], cwds: [...cached.cwds], state: structuredClone(cached.state) }
        } else {
          entry = { agent: source.agent, size, mtimeMs, offset: 0, guard: '', state: source.parser.initial(), models: [], sessions: [], cwds: [], recs: [] }
        }
        await readLines(path, entry, source.parser, floor, sessionCwds)
        entry.size = size
        entry.mtimeMs = mtimeMs
        entry.guard = await guardOf(path, entry.offset)
        cache.files[path] = entry
        report.readFiles++
        this.dirty = true
      } catch {
        report.status = 'partial'
      }
    })
    return report
  }

  /** OpenCode's database is read again whenever it or its write-ahead log changed. */
  private async scanOpenCode(cache: CacheFile, floor: number, seen: Set<string>): Promise<UsageHistorySource> {
    const roots = [...new Set(openCodeRoots().map((root) => resolve(root)))]
    const report: UsageHistorySource = { agent: 'opencode', path: roots[0] ?? '', status: 'missing', files: 0, readFiles: 0 }
    for (const root of roots) {
      const path = join(root, 'opencode.db')
      if (!existsSync(path)) continue
      report.path = root
      report.status = 'read'
      report.files++
      seen.add(path)
      try {
        const db = await stat(path)
        const wal = await stat(`${path}-wal`).catch(() => null)
        const size = db.size + (wal?.size ?? 0)
        const mtimeMs = Math.max(db.mtimeMs, wal?.mtimeMs ?? 0)
        const cached = cache.files[path]
        if (cached && cached.size === size && cached.mtimeMs === mtimeMs) continue
        const entry: FileEntry = { agent: 'opencode', size, mtimeMs, offset: 0, guard: '', state: null, models: [], sessions: [], cwds: [], recs: [] }
        const database = await openReadOnly(path, 'SELECT 1 FROM message LIMIT 1')
        try {
          const rows = database.prepare("SELECT id, session_id, time_created, data FROM message WHERE time_created >= ? AND data LIKE '%\"assistant\"%'").all(floor) as Array<{ id: string; session_id: string; time_created: number; data: string }>
          for (const row of rows) {
            try {
              const data = JSON.parse(row.data)
              const tokens = data?.tokens
              const model = typeof data?.modelID === 'string' ? data.modelID : ''
              if (data?.role !== 'assistant' || !tokens || !model) continue
              const n = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0)
              entry.recs.push(pack(entry, {
                ts: n(data.time?.created) || row.time_created, model, session: row.session_id,
                input: n(tokens.input), cacheRead: n(tokens.cache?.read), cacheWrite: n(tokens.cache?.write),
                output: n(tokens.output) + n(tokens.reasoning), key: `o:${row.id}`,
                ...(n(data.cost) ? { costUsd: n(data.cost) } : {})
              }))
            } catch {
              // A malformed row is skipped.
            }
          }
        } finally {
          database.close()
        }
        cache.files[path] = entry
        report.readFiles++
        this.dirty = true
      } catch {
        report.status = 'partial'
      }
    }
    return report
  }
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function dayKeyFn(timeZone: string | undefined): (ts: number) => string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  let format = dayFormatters.get(zone)
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    } catch {
      format = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    dayFormatters.set(zone, format)
  }
  // Every zone's day starts on a quarter hour, so one answer serves a quarter hour.
  const memo = new Map<number, string>()
  return (ts) => {
    const slot = Math.floor(ts / 900_000)
    let key = memo.get(slot)
    if (key === undefined) { key = format!.format(slot * 900_000); memo.set(slot, key) }
    return key
  }
}

function shiftDay(key: string, days: number): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}

/** Dollars kept to a hundredth of a cent: finer is noise, and the reply stays small enough to cross the device link. */
const cents = (value: number) => Math.round(value * 1e4) / 1e4
const sum = (tokens: UsageTokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
const zero = (): UsageTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

export function aggregate(result: ScanResult, request: UsageHistoryRequest, now: number): UsageHistoryResponse {
  const dayKey = dayKeyFn(request.timeZone)
  const hourly = request.range === '24h'
  const dayCount = request.range === '7d' ? 7 : request.range === '30d' ? 30 : 90
  const hourMs = 3_600_000
  const firstHour = Math.floor(now / hourMs) * hourMs - 23 * hourMs
  const today = dayKey(now)
  const dayKeys = hourly ? [] : Array.from({ length: dayCount }, (_, i) => shiftDay(today, i - dayCount + 1))
  const dayIndex = new Map(dayKeys.map((key, i) => [key, i]))
  const buckets = hourly
    ? Array.from({ length: 24 }, (_, i) => firstHour + i * hourMs)
    : dayKeys.map((key) => Date.parse(`${key}T00:00:00`))
  const start = hourly ? firstHour : now - (dayCount + 1) * DAY

  // The same call logged in several files counts once; the copy with the most output wins.
  const calls = new Map<string, { agent: UsageAgentId; entry: FileEntry; rec: Packed }>()
  const present = new Set<UsageAgentId>()
  for (const [, entry] of result.entries) {
    for (const rec of entry.recs) {
      if (rec[0] < start) continue
      const prior = calls.get(rec[7])
      if (!prior || prior.rec[6] < rec[6]) calls.set(rec[7], { agent: entry.agent, entry, rec })
    }
  }

  const agents = new Map<UsageAgentId, UsageHistoryAgent & { sessionSet: Set<string> }>()
  const models = new Map<string, UsageHistoryModelRow>()
  const days = new Map<string, { tokens: number; costUsd: number; sessions: Set<string> }>()
  const totals = zero()
  const costByKind = zero()
  let costUnsplitUsd = 0
  const costBySpeed = { fast: 0, standard: 0, unknown: 0 }
  const projects = new Map<string, UsageProjectRow & { sessionSet: Set<string> }>()
  const sessionRows = new Map<string, UsageSessionRow & { modelCost: Map<string, number> }>()
  let costUsd = 0
  let cacheSavingsUsd = 0
  const allSessions = new Set<string>()
  for (const { agent, entry, rec } of calls.values()) {
    const [ts, modelIndex, sessionIndex, input, cacheRead, cacheWrite, output, , logged, speed, cwdIndex] = rec
    const reported = logged ?? undefined
    const day = dayKey(ts)
    const bucket = hourly ? Math.floor((ts - firstHour) / hourMs) : dayIndex.get(day)
    if (bucket === undefined || bucket < 0 || bucket >= buckets.length) continue
    present.add(agent)
    if (request.agent && agent !== request.agent) continue
    const model = entry.models[modelIndex] ?? ''
    const session = `${agent}:${entry.sessions[sessionIndex] ?? ''}`
    const price = priceFor(model)
    const listed = price ? costOf(price, input, cacheRead, cacheWrite, output) : 0
    const cost = reported ?? listed
    const priced = reported !== undefined || !!price
    if (listed > 0) {
      // A reported cost is split in the shares the list prices give.
      const scale = cost / listed
      costByKind.input += (input * price!.input * scale) / 1e6
      costByKind.cacheRead += (cacheRead * price!.cacheRead * scale) / 1e6
      costByKind.cacheWrite += (cacheWrite * price!.cacheWrite * scale) / 1e6
      costByKind.output += (output * price!.output * scale) / 1e6
    } else {
      costUnsplitUsd += cost
    }
    costBySpeed[speed === 2 ? 'fast' : speed === 1 ? 'standard' : 'unknown'] += cost
    const tokens = input + cacheRead + cacheWrite + output
    let row = agents.get(agent)
    if (!row) {
      row = { id: agent, label: USAGE_AGENT_LABELS[agent], sessions: 0, sessionSet: new Set(), tokens: zero(), costUsd: 0, unpricedTokens: 0, series: buckets.map(() => 0), costSeries: buckets.map(() => 0) }
      agents.set(agent, row)
    }
    row.tokens.input += input; row.tokens.cacheRead += cacheRead; row.tokens.cacheWrite += cacheWrite; row.tokens.output += output
    row.costUsd += cost
    if (!priced) row.unpricedTokens += tokens
    row.series[bucket] += tokens
    row.costSeries[bucket] += cost
    row.sessionSet.add(session)
    allSessions.add(session)
    totals.input += input; totals.cacheRead += cacheRead; totals.cacheWrite += cacheWrite; totals.output += output
    costUsd += cost
    if (price) cacheSavingsUsd += (cacheRead * (price.input - price.cacheRead)) / 1e6
    const modelKey = `${agent}\u0000${model}`
    const modelRow = models.get(modelKey) ?? { model, agent, tokens: 0, costUsd: 0, priced }
    modelRow.tokens += tokens
    modelRow.costUsd += cost
    models.set(modelKey, modelRow)
    const cwd = cwdIndex == null ? '' : entry.cwds[cwdIndex] ?? ''
    const projectRow = projects.get(cwd) ?? { name: cwd, tokens: 0, costUsd: 0, sessions: 0, sessionSet: new Set<string>() }
    projectRow.tokens += tokens
    projectRow.costUsd += cost
    projectRow.sessionSet.add(session)
    projects.set(cwd, projectRow)
    const sessionId = entry.sessions[sessionIndex] ?? ''
    if (sessionId) {
      const sessionRow = sessionRows.get(session) ?? { agent, session: sessionId, model, project: cwd, tokens: 0, costUsd: 0, firstAt: ts, lastAt: ts, modelCost: new Map<string, number>() }
      sessionRow.tokens += tokens
      sessionRow.costUsd += cost
      sessionRow.firstAt = Math.min(sessionRow.firstAt, ts)
      sessionRow.lastAt = Math.max(sessionRow.lastAt, ts)
      if (cwd && !sessionRow.project) sessionRow.project = cwd
      sessionRow.modelCost.set(model, (sessionRow.modelCost.get(model) ?? 0) + cost)
      sessionRows.set(session, sessionRow)
    }
    const dayRow = days.get(day) ?? { tokens: 0, costUsd: 0, sessions: new Set<string>() }
    dayRow.tokens += tokens
    dayRow.costUsd += cost
    dayRow.sessions.add(session)
    days.set(day, dayRow)
  }
  const agentRows = [...agents.values()]
    .map(({ sessionSet, ...row }) => ({ ...row, costUsd: cents(row.costUsd), costSeries: row.costSeries.map(cents), sessions: sessionSet.size }))
    .sort((a, b) => sum(b.tokens) - sum(a.tokens) || a.label.localeCompare(b.label))
  return {
    range: request.range,
    bucket: hourly ? 'hour' : 'day',
    buckets,
    dayKeys,
    agents: agentRows,
    models: [...models.values()].map((row) => ({ ...row, costUsd: cents(row.costUsd) })).sort((a, b) => b.tokens - a.tokens),
    days: [...days.entries()].map(([day, row]) => ({ day, tokens: row.tokens, costUsd: cents(row.costUsd), sessions: row.sessions.size })).sort((a, b) => (a.day < b.day ? 1 : -1)),
    totals,
    costUsd: cents(costUsd),
    costByKind: { input: cents(costByKind.input), cacheRead: cents(costByKind.cacheRead), cacheWrite: cents(costByKind.cacheWrite), output: cents(costByKind.output) },
    costUnsplitUsd: cents(costUnsplitUsd),
    costBySpeed: { fast: cents(costBySpeed.fast), standard: cents(costBySpeed.standard), unknown: cents(costBySpeed.unknown) },
    projects: [...projects.values()].map(({ sessionSet, ...row }) => ({ ...row, costUsd: cents(row.costUsd), sessions: sessionSet.size }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    // The priciest five, each named by the model that cost it most.
    topSessions: [...sessionRows.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens).slice(0, 5)
      .map(({ modelCost, ...row }) => ({ ...row, model: [...modelCost].sort((a, b) => b[1] - a[1])[0]?.[0] ?? row.model, costUsd: cents(row.costUsd) })),
    agentIds: [...present].sort((a, b) => USAGE_AGENT_LABELS[a].localeCompare(USAGE_AGENT_LABELS[b])),
    cacheSavingsUsd: cents(cacheSavingsUsd),
    sessions: allSessions.size,
    sources: result.sources,
    readAt: new Date(now).toISOString(),
    scanMs: result.scanMs
  }
}

/**
 * Opens a SQLite database read-only. Where the folder can't share its lock files (a network or
 * mounted drive), a copy of the database and its write-ahead log is read instead.
 */
async function openReadOnly(path: string, probeSql: string): Promise<import('node:sqlite').DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite')
  try {
    const database = new DatabaseSync(path, { readOnly: true })
    database.prepare(probeSql).get()
    return database
  } catch {
    const dir = await mkdtemp(join(tmpdir(), 'mousse-usage-db-'))
    try {
      const copy = join(dir, 'db.sqlite')
      await copyFile(path, copy)
      await copyFile(`${path}-wal`, `${copy}-wal`).catch(() => undefined)
      const database = new DatabaseSync(copy)
      const close = database.close.bind(database)
      database.close = () => { close(); void rm(dir, { recursive: true, force: true }) }
      return database
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
}

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getUsageHistoryWorkerBuildOptions } from '../scripts/build-cli.mjs'
import { UsageHistoryScanner } from '../src/mms/usageHistory/UsageHistoryScanner'
import { UsageHistoryReader } from '../src/mms/usageHistory/usageHistoryReader'
import type { UsageHistoryResponse } from '../src/shared/usageHistory'

// Log lines in each agent's own format, written by hand from real logs (Claude Code 2.x, Codex 0.6x, Grok, Pi, Antigravity).
const NOW = Date.parse('2026-11-19T12:00:00Z')
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()
const claudeLine = (id: string, hoursAgo: number, usage: Record<string, number>, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: at(hoursAgo), message: { id, model, usage, content: [{ type: 'text', text: 'x'.repeat(40) }] } })
const codexLines = (hoursAgo: number) => [
  JSON.stringify({ type: 'session_meta', payload: { id: 'cx1' } }),
  JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }),
  JSON.stringify({ timestamp: at(hoursAgo), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1500 }, last_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300 } } } }),
  // The same event again (Codex repeats it): the running total didn't move, so it isn't counted twice.
  JSON.stringify({ timestamp: at(hoursAgo), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1500 }, last_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300 } } } })
]
const grokLine = (hoursAgo: number) => JSON.stringify({ params: { sessionId: 'g1', _meta: { agentTimestampMs: NOW - hoursAgo * 3_600_000 }, update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: { modelUsage: { 'grok-code-fast': { inputTokens: 900, cachedReadTokens: 400, outputTokens: 50, costUsdTicks: 2_500_000_000 } } } } } })
const piLines = (hoursAgo: number) => [
  JSON.stringify({ type: 'session', id: 'pi1' }),
  JSON.stringify({ type: 'message', id: 'm1', timestamp: at(hoursAgo), message: { role: 'assistant', model: 'house-model', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, cost: { total: 0.5 } } } })
]
const antigravityLine = (step: number, hoursAgo: number, fields: Record<string, unknown>) =>
  JSON.stringify({ step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(hoursAgo), ...fields })
const writeAntigravitySummaries = (appDir: string, rows: ReadonlyArray<[string, string[]]>) => {
  mkdirSync(appDir, { recursive: true })
  const db = new DatabaseSync(join(appDir, 'conversation_summaries.db'))
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)')
  const insert = db.prepare('INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)')
  for (const [id, paths] of rows) insert.run(id, JSON.stringify(paths.map((p) => pathToFileURL(p).href)))
  db.close()
}

let home: string
let cachePath: string
const write = (path: string, lines: string[]) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, lines.map((line) => `${line}\n`).join('')) }
const claudeLog = () => join(home, '.claude', 'projects', 'repo', 'a.jsonl')
const scanner = () => new UsageHistoryScanner(cachePath, () => NOW)
const tokensOf = (history: UsageHistoryResponse, agent: string) => {
  const row = history.agents.find((entry) => entry.id === agent)
  return row ? row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite + row.tokens.output : 0
}
const sourceOf = (history: UsageHistoryResponse, agent: string) => history.sources.find((source) => source.agent === agent)!

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'usage-history-'))
  cachePath = join(home, 'mousse', 'cache', 'usage-history-v1.json')
  process.env.MOUSSE_USAGE_LOG_HOME = home
  write(claudeLog(), [
    claudeLine('msg_1', 2, { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 40 }),
    // One message logged once per content block: counted once.
    claudeLine('msg_1', 2, { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 40 }),
    JSON.stringify({ type: 'assistant', timestamp: at(1), message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 999 } } })
  ])
  write(join(home, '.codex', 'sessions', '2026', '11', 'r.jsonl'), codexLines(5))
  write(join(home, '.grok', 'sessions', 'g1', 'updates.jsonl'), [grokLine(3)])
  write(join(home, '.pi', 'agent', 'sessions', 'w', 'p.jsonl'), piLines(4))
})

afterEach(() => {
  delete process.env.MOUSSE_USAGE_LOG_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('usage history from the agents\' own logs', () => {
  it('reads each agent\'s format once per model call, with the uncached input apart from the cache', async () => {
    const history = await scanner().history({ range: '24h', timeZone: 'UTC' })
    const claude = history.agents.find((agent) => agent.id === 'claude-code')!
    expect(claude.tokens).toEqual({ input: 10, cacheRead: 5000, cacheWrite: 200, output: 40 })
    expect(history.agents.find((agent) => agent.id === 'codex')!.tokens).toEqual({ input: 200, cacheRead: 1000, cacheWrite: 0, output: 300 })
    expect(history.agents.find((agent) => agent.id === 'grok')!.tokens).toEqual({ input: 500, cacheRead: 400, cacheWrite: 0, output: 50 })
    // Grok logs its own cost in ticks of 1e-10 dollars; Pi logs dollars.
    expect(history.agents.find((agent) => agent.id === 'grok')!.costUsd).toBeCloseTo(0.25, 4)
    expect(history.agents.find((agent) => agent.id === 'pi')!.costUsd).toBeCloseTo(0.5, 4)
    expect(history.sessions).toBe(4)
    expect(history.buckets).toHaveLength(24)
    expect(claude.series.reduce((a, b) => a + b, 0)).toBe(5250)
  })

  it('splits the cost by kind of token; a logged cost for a model with no list price stays unsplit', async () => {
    const history = await scanner().history({ range: '7d', timeZone: 'UTC' })
    const split = history.costByKind.input + history.costByKind.cacheRead + history.costByKind.cacheWrite + history.costByKind.output
    expect(history.costUnsplitUsd).toBeCloseTo(0.5, 4)
    expect(split + history.costUnsplitUsd).toBeCloseTo(history.costUsd, 3)
    expect(history.costByKind.output).toBeGreaterThan(0)
  })

  it('splits the cost by speed where the log says it, and adds up each folder and the priciest sessions', async () => {
    // A fast-mode Claude call and a Codex thread on the priority tier, both in /work/app.
    write(join(home, '.claude', 'projects', 'app', 'b.jsonl'), [JSON.stringify({
      type: 'assistant', sessionId: 's2', cwd: '/work/app', timestamp: at(1),
      message: { id: 'msg_f', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1000, speed: 'fast' } }
    })])
    const [meta, context, ...counts] = codexLines(5)
    write(join(home, '.codex', 'sessions', '2026', '11', 'r.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'cx1', cwd: '/work/app' } }), context!,
      JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } }), ...counts
    ])
    expect(meta).toContain('session_meta')
    const history = await scanner().history({ range: '7d', timeZone: 'UTC' })
    const fast = (agent: string) => history.agents.find((entry) => entry.id === agent)!.costUsd
    // Fast calls are priced at list prices; the a.jsonl call, Grok and Pi don't say their speed.
    expect(history.costBySpeed.fast).toBeCloseTo(history.topSessions.find((row) => row.session === 's2')!.costUsd + fast('codex'), 3)
    expect(history.costBySpeed.standard).toBe(0)
    expect(history.costBySpeed.fast + history.costBySpeed.unknown).toBeCloseTo(history.costUsd, 3)

    const app = history.projects.find((row) => row.name === '/work/app')!
    expect(app.sessions).toBe(2)
    expect(app.tokens).toBe(2000 + 1500)
    expect(history.projects.reduce((sum, row) => sum + row.tokens, 0)).toBe(history.agents.reduce((sum, row) => sum + tokensOf(history, row.id), 0))

    expect(history.topSessions.map((row) => row.costUsd)).toEqual([...history.topSessions.map((row) => row.costUsd)].sort((a, b) => b - a))
    expect(history.topSessions.find((row) => row.session === 's2')).toMatchObject({ agent: 'claude-code', project: '/work/app', model: 'claude-opus-5-5', tokens: 2000 })
  })

  it('narrows to one provider and still lists every provider with usage', async () => {
    const history = await scanner().history({ range: '7d', timeZone: 'UTC', agent: 'codex' })
    expect(history.agents.map((agent) => agent.id)).toEqual(['codex'])
    expect(history.models.every((model) => model.agent === 'codex')).toBe(true)
    expect(history.totals).toEqual({ input: 200, cacheRead: 1000, cacheWrite: 0, output: 300 })
    expect([...history.agentIds].sort()).toEqual(['claude-code', 'codex', 'grok', 'pi'])
  })

  // What can happen to a log between two reads, and what the history must then show.
  const changes: Array<[string, (scan: UsageHistoryScanner) => void, number, number]> = [
    // [change, apply, Claude Code tokens after, Claude logs read again]
    ['nothing', () => undefined, 5250, 0],
    ['a call appended', () => appendFileSync(claudeLog(), `${claudeLine('msg_2', 1, { input_tokens: 1, output_tokens: 9 })}\n`), 5260, 1],
    ['half a line appended (still being written)', () => appendFileSync(claudeLog(), claudeLine('msg_3', 1, { input_tokens: 7, output_tokens: 3 }).slice(0, 60)), 5250, 1],
    ['rewritten shorter', () => write(claudeLog(), [claudeLine('msg_9', 1, { input_tokens: 2, output_tokens: 2 })]), 4, 1],
    ['deleted', () => rmSync(claudeLog()), 5250, 0]
  ]
  it.each(changes)('after %s, a second read counts each call once and reads only what changed', async (_, change, tokens, reread) => {
    const scan = scanner()
    await scan.history({ range: '24h', timeZone: 'UTC' })
    change(scan)
    const second = await scan.history({ range: '24h', timeZone: 'UTC' })
    expect(tokensOf(second, 'claude-code')).toBe(tokens)
    expect(sourceOf(second, 'claude-code').readFiles).toBe(reread)
    // A new scanner on the saved cache (the next start) gives the same numbers without reading the logs again.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const restarted = await scanner().history({ range: '24h', timeZone: 'UTC' })
    expect(tokensOf(restarted, 'claude-code')).toBe(tokens)
    expect(sourceOf(restarted, 'claude-code').readFiles).toBe(0)
  })

  it('reads Antigravity transcripts from both standalone and Mousse profile homes, handles checkpoints, and reads workspaces', async () => {
    const cliDir = join(home, '.gemini', 'antigravity-cli')
    const cliTranscript = join(cliDir, 'brain', 'agy-cli-1', '.system_generated', 'logs', 'transcript.jsonl')
    write(cliTranscript, [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: at(4), content: 'hi' }),
      antigravityLine(1, 4, { model: 'gemini-4-neon-high', input_tokens: 400, cache_read_tokens: 1000, output_tokens: 80 }),
      // Compaction checkpoint omits `model`; it inherits the session's latest model.
      JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: at(3), input_tokens: 50, cache_read_tokens: 500, output_tokens: 20 }),
      // Duplicate step_index with fewer output tokens is ignored; zero-token and malformed lines are skipped.
      antigravityLine(1, 4, { model: 'gemini-4-neon-high', input_tokens: 400, cache_read_tokens: 1000, output_tokens: 40 }),
      antigravityLine(3, 3, { model: 'gemini-4-neon-high', input_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }),
      '{bad json'
    ])
    // `transcript_full.jsonl` beside `transcript.jsonl` must never be double-counted.
    write(join(cliDir, 'brain', 'agy-cli-1', '.system_generated', 'logs', 'transcript_full.jsonl'), [
      antigravityLine(99, 4, { model: 'gemini-4-neon-high', input_tokens: 99999, cache_read_tokens: 0, output_tokens: 1 })
    ])
    const profileAppDir = join(home, '.mousse', 'profiles', 'prf_1', 'providers', 'antigravity', 'gemini-home', 'antigravity-acp')
    const acpTranscript = join(profileAppDir, 'brain', 'agy-acp-1', '.system_generated', 'logs', 'transcript.jsonl')
    write(acpTranscript, [
      antigravityLine(1, 2, { model: 'claude-opus-5-5', input_tokens: 2000, cache_read_tokens: 10000, output_tokens: 500 })
    ])
    writeAntigravitySummaries(profileAppDir, [['agy-acp-1', ['/work/mousse', '/home/me']]])

    const scan = scanner()
    const history = await scan.history({ range: '24h', timeZone: 'UTC', agent: 'antigravity' })
    const agy = history.agents.find((agent) => agent.id === 'antigravity')!
    expect(agy.label).toBe('Antigravity')
    expect(agy.sessions).toBe(2)
    expect(agy.tokens).toEqual({ input: 2450, cacheRead: 11500, cacheWrite: 0, output: 600 })
    expect(agy.unpricedTokens).toBe(2050)
    expect(agy.costUsd).toBeGreaterThan(0)
    expect(history.models.find((m) => m.model === 'gemini-4-neon-high')).toMatchObject({ agent: 'antigravity', tokens: 2050, priced: false, costUsd: 0 })
    expect(history.models.find((m) => m.model === 'claude-opus-5-5')).toMatchObject({ agent: 'antigravity', tokens: 12500, priced: true })
    expect(history.projects.find((p) => p.name === '/work/mousse')).toMatchObject({ tokens: 12500, sessions: 1 })
    expect(history.topSessions[0]).toMatchObject({ agent: 'antigravity', session: 'agy-acp-1', project: '/work/mousse', tokens: 12500 })
    expect(history.agentIds).toContain('antigravity')

    // Appending a new step increments the cached Antigravity transcript without rereading the unchanged one.
    appendFileSync(cliTranscript, `${antigravityLine(4, 1, { model: 'gemini-4-neon-high', input_tokens: 100, cache_read_tokens: 0, output_tokens: 50 })}\n`)
    const second = await scan.history({ range: '24h', timeZone: 'UTC', agent: 'antigravity' })
    expect(tokensOf(second, 'antigravity')).toBe(2450 + 11500 + 600 + 150)
    expect(sourceOf(second, 'antigravity').readFiles).toBe(1)
  })

  it('reads the transcripts of an Antigravity entry added after the first, in its own home', async () => {
    const entryHome = join(home, '.mousse', 'profiles', 'prf_1', 'harness', 'antigravity_antigravity-2', 'home')
    write(join(entryHome, 'gemini-home', 'antigravity-acp', 'brain', 'agy-second', '.system_generated', 'logs', 'transcript.jsonl'), [
      antigravityLine(1, 2, { model: 'gemini-4-neon-high', input_tokens: 300, cache_read_tokens: 0, output_tokens: 30 })
    ])
    const history = await scanner().history({ range: '24h', timeZone: 'UTC', agent: 'antigravity' })
    expect(history.topSessions.map((row) => row.session)).toContain('agy-second')
  })

  it('ranks unpriced Antigravity sessions by token count when their list cost is zero', async () => {
    const cliDir = join(home, '.gemini', 'antigravity-cli')
    write(join(cliDir, 'brain', 'agy-small', '.system_generated', 'logs', 'transcript.jsonl'), [
      antigravityLine(1, 3, { model: 'gemini-4-neon-high', input_tokens: 100, cache_read_tokens: 0, output_tokens: 20 })
    ])
    write(join(cliDir, 'brain', 'agy-big', '.system_generated', 'logs', 'transcript.jsonl'), [
      antigravityLine(1, 2, { model: 'gemini-4-neon-high', input_tokens: 5000, cache_read_tokens: 20000, output_tokens: 1000 })
    ])
    const history = await scanner().history({ range: '24h', timeZone: 'UTC', agent: 'antigravity' })
    expect(history.topSessions.map((row) => row.session)).toEqual(['agy-big', 'agy-small'])
  })

  it('drops what it kept from another home folder once that folder is no longer read', async () => {
    await scanner().history({ range: '24h', timeZone: 'UTC' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const other = mkdtempSync(join(tmpdir(), 'usage-history-other-'))
    try {
      process.env.MOUSSE_USAGE_LOG_HOME = other
      const history = await scanner().history({ range: '24h', timeZone: 'UTC' })
      expect(history.agents).toEqual([])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('the usage history worker', () => {
  let workerDir: string
  beforeAll(async () => {
    workerDir = mkdtempSync(join(tmpdir(), 'usage-history-worker-'))
    const options = getUsageHistoryWorkerBuildOptions(join(__dirname, '..'), 'out/cli')
    await build({ ...options, outfile: join(workerDir, 'usageHistoryWorker.js'), logLevel: 'silent' })
  }, 60_000)
  afterAll(() => rmSync(workerDir, { recursive: true, force: true }))

  it('answers on its own thread with the same history as a read in this process', async () => {
    const reader = new UsageHistoryReader(cachePath, join(workerDir, 'usageHistoryWorker.js'))
    const [fromWorker, inProcess] = await Promise.all([
      reader.history({ range: '7d', timeZone: 'UTC' }),
      new UsageHistoryScanner(join(home, 'other-cache.json')).history({ range: '7d', timeZone: 'UTC' })
    ])
    expect(fromWorker.totals).toEqual(inProcess.totals)
    expect(fromWorker.agents.map((agent) => agent.id)).toEqual(inProcess.agents.map((agent) => agent.id))
    // A second request reuses the running worker and its cache.
    const again = await reader.history({ range: '24h', timeZone: 'UTC' })
    expect(again.sources.every((source) => source.readFiles === 0)).toBe(true)
  }, 60_000)
})

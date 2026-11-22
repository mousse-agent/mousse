import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateRemoteParams } from '../../../../src/mms/bridge/remote'
import { executeBridgeHubLocal } from '../../../../src/mms/bridge/hub/local'
import { parseUsageHistory } from '../../../../src/renderer/lib/usageHistoryDevices'
import { cleanup, fixture } from '../hub/fixture'

let logs: string
beforeEach(() => {
  // The other computer's own Claude Code log: one call an hour ago.
  logs = mkdtempSync(join(tmpdir(), 'usage-history-remote-'))
  const file = join(logs, '.claude', 'projects', 'secret-project', 'session.jsonl')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify({
    type: 'assistant', sessionId: 's1', timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 88 } }
  })}\n`)
  process.env.MOUSSE_USAGE_LOG_HOME = logs
})
afterEach(async () => {
  await cleanup()
  delete process.env.MOUSSE_USAGE_LOG_HOME
  rmSync(logs, { recursive: true, force: true })
})

describe('remote usage.history', () => {
  it('takes a range, and optionally a time zone and a provider, and nothing else', () => {
    expect(() => validateRemoteParams('usage.history', { range: '30d' })).not.toThrow()
    expect(() => validateRemoteParams('usage.history', { range: '24h', timeZone: 'Europe/London', agent: 'codex' })).not.toThrow()
    expect(() => validateRemoteParams('usage.history', { range: '24h', agent: 'antigravity' })).not.toThrow()
    for (const bad of [{}, { range: '1y' }, { range: '7d', agent: 'cursor' }, { range: '7d', timeZone: '' }, { range: '7d', path: '/etc' }, { range: '7d', refresh: true }])
      expect(() => validateRemoteParams('usage.history', bad)).toThrow()
  })

  it('sends Antigravity totals over the device link without leaking local paths', async () => {
    const agyFile = join(logs, '.mousse', 'profiles', 'prf_1', 'providers', 'antigravity', 'gemini-home', 'antigravity-acp', 'brain', 'agy-secret', '.system_generated', 'logs', 'transcript.jsonl')
    mkdirSync(join(agyFile, '..'), { recursive: true })
    writeFileSync(agyFile, `${JSON.stringify({
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
      model: 'gemini-4-neon-high', input_tokens: 400, cache_read_tokens: 1600, output_tokens: 100
    })}\n`)
    const f = await fixture(['read'])
    await f.connect()
    const reply = await executeBridgeHubLocal(f.hub(), 'bridge.hub.usageHistory', { target: f.targetNode, range: '24h', timeZone: 'UTC', agent: 'antigravity' })
    const history = parseUsageHistory(reply)
    expect(history.totals).toEqual({ input: 400, cacheRead: 1600, cacheWrite: 0, output: 100 })
    expect(history.agents.map((agent) => agent.id)).toEqual(['antigravity'])
    expect(JSON.stringify(reply)).not.toContain('agy-secret')
    expect(reply).toMatchObject({ projects: [], topSessions: [] })
  })

  it('answers a computer with the read capability with the totals of its own logs, and no path', async () => {
    const f = await fixture(['read'])
    await f.connect()
    const reply = await executeBridgeHubLocal(f.hub(), 'bridge.hub.usageHistory', { target: f.targetNode, range: '24h', timeZone: 'UTC' })
    const history = parseUsageHistory(reply)
    expect(history.totals).toEqual({ input: 12, cacheRead: 3000, cacheWrite: 0, output: 88 })
    expect(history.agents.map((agent) => agent.id)).toEqual(['claude-code'])
    // The numbers cross the link, never where the logs are.
    const text = JSON.stringify(reply)
    expect(text).not.toContain('secret-project')
    expect(text).not.toContain(logs.replaceAll('\\', '\\\\'))
    // Nor its projects or sessions: those stay on the computer.
    expect(reply).toMatchObject({ projects: [], topSessions: [] })
  })

  it('refuses a computer without the read capability', async () => {
    const chatOnly = await fixture(['chat'])
    await chatOnly.connect()
    await expect(executeBridgeHubLocal(chatOnly.hub(), 'bridge.hub.usageHistory', { target: chatOnly.targetNode, range: '7d' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

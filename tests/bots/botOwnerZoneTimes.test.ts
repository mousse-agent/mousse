/**
 * A personal bot reads the times in its Mousse tool results on its owner's clock, as its "Now" line: a report the
 * chat holds at 10:33 UTC is 16:03 to an owner in India, never "10:33". A bare date it searches by is the owner's day.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { localizeIsoTimes, zonedDayBound } from '../../src/mms/bots/memory/render'
import { RunCounters } from '../../src/mms/harness/budget'
import { BOT_DEFAULT_APP_TOOLS } from '../../src/shared/bots/personal/manifest'
import { appToolRegistry, appTurn, fakeAppToolHost } from '../run/appToolsFixture'
import { delegationFixture, type DelegationFixture } from '../run/delegationFixture'
import { disposeFixtures, memoryFixture } from './memory/memoryFixture'

const INDIA = 'Asia/Calcutta'

let fx: DelegationFixture | undefined
afterEach(() => {
  fx?.dispose()
  fx = undefined
  disposeFixtures()
})

describe('UTC times written on the owner\'s clock', () => {
  it.each([
    // [zone, text, expected]
    [INDIA, '{"at":"2026-11-19T10:33:43.120Z"}', '{"at":"2026-11-19T16:03:43.120+05:30"}'],
    [INDIA, 'sent 2026-11-19T20:45Z', 'sent 2026-11-20T02:15+05:30'],
    [INDIA, '"updatedAt":"2026-11-19T10:33:43Z","seq":4', '"updatedAt":"2026-11-19T16:03:43+05:30","seq":4'],
    ['America/New_York', '"at":"2026-11-19T03:00:00.000Z"', '"at":"2026-11-18T22:00:00.000-05:00"'],
    // Summer time: the offset of that instant, not of today.
    ['America/New_York', '"at":"2026-07-01T12:00:00.000Z"', '"at":"2026-07-01T08:00:00.000-04:00"'],
    // An owner on UTC, an unknown zone, and text with no UTC time stay as they are.
    ['UTC', '"at":"2026-11-19T10:33:43.120Z"', '"at":"2026-11-19T10:33:43.120Z"'],
    ['Not/AZone', '"at":"2026-11-19T10:33:43.120Z"', '"at":"2026-11-19T10:33:43.120Z"'],
    [INDIA, 'no times; 2026-11-19; 10:33; Z', 'no times; 2026-11-19; 10:33; Z'],
    [INDIA, '"at":"2026-11-19T16:03:43+05:30"', '"at":"2026-11-19T16:03:43+05:30"'],
    [INDIA, 'not a day: 2026-13-40T10:33:00Z', 'not a day: 2026-13-40T10:33:00Z']
  ])('%s: %s', (zone, text, expected) => {
    expect(localizeIsoTimes(text, zone)).toBe(expected)
    // The same instant: what parses back is what was there.
    const iso = /\d{4}-\d{2}-\d{2}T[^"; ]+/.exec(text)?.[0]
    const out = /\d{4}-\d{2}-\d{2}T[^"; ]+/.exec(expected)?.[0]
    if (iso && out && Number.isFinite(Date.parse(iso))) expect(Date.parse(out)).toBe(Date.parse(iso))
  })

  it.each([
    // [day, zone, start, end]
    ['2026-11-19', INDIA, '2026-11-18T18:30:00.000Z', '2026-11-19T18:29:59.999Z'],
    ['2026-11-19', 'UTC', '2026-11-19T00:00:00.000Z', '2026-11-19T23:59:59.999Z'],
    // The day the clocks go forward is 23 hours long.
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z']
  ])('the owner\'s day %s in %s', (day, zone, start, end) => {
    expect(zonedDayBound(day, zone)).toBe(start)
    expect(zonedDayBound(day, zone, true)).toBe(end)
  })

  it('a bare date is a day only when it is one', () => {
    expect(zonedDayBound('2026-02-30', INDIA)).toBeUndefined()
    expect(zonedDayBound('2026-11-19T10:00Z', INDIA)).toBeUndefined()
  })
})

describe('a bot\'s memory, on its owner\'s clock', () => {
  it('memory_search by a bare date finds the owner\'s day, not the UTC day', () => {
    const memory = memoryFixture({ timeZone: () => INDIA })
    // 00:30 on the 19th in India, still the 18th in UTC.
    memory.message({ botId: 'b1', id: 'm1', author: 'bot', text: 'Report sent to the owner', at: '2026-11-18T19:00:00.000Z' })
    const refs = (input: { since?: string; until?: string }) => memory.store.search('b1', { query: 'report', ...input }).map((hit) => hit.ref)
    expect(refs({ since: '2026-11-19' })).toEqual(['j1'])
    expect(refs({ until: '2026-11-18' })).toEqual([])
    expect(refs({ until: '2026-11-19' })).toEqual(['j1'])
    // A full time still means exactly that instant.
    expect(refs({ since: '2026-11-18T19:00:01.000Z' })).toEqual([])
  })

  it('a bot turn reads its history\'s times on its owner\'s clock through the Mousse tools', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const memory = memoryFixture({ timeZone: () => INDIA })
    memory.message({ botId: 'b1', id: 'm1', author: 'bot', text: 'Report sent to the owner', at: '2026-11-19T10:33:43.000Z' })
    const host = { activationOf: (threadId: string) => (threadId === 'thread-a' ? { botId: 'b1', activationId: 'act-1', lane: 'chat' as const, memoryLane: 'chat' as const } : undefined), memory: memory.store }
    const { registry, turns, request } = appToolRegistry(fx.engine, fakeAppToolHost().host, { botMemory: () => host })
    turns.register(appTurn({
      threadId: 'thread-a',
      runId: run.runId,
      bot: createBotAuthority({
        activationId: 'act-1',
        role: 'activation',
        permissions: { tools: [], appTools: [...BOT_DEFAULT_APP_TOOLS], mcp: [], skills: [], workspace: null },
        waiting: () => false,
        counters: new RunCounters(),
        time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
        spend: null
      })
    }))
    const outcome = await registry.call('memory_search', { query: 'report' }, request({ threadId: 'thread-a', runId: run.runId }))
    expect(outcome.isError).toBeFalsy()
    const hits = (JSON.parse(outcome.text) as { hits: Array<{ at: string; snippet: string }> }).hits
    expect(hits[0]?.at).toBe('2026-11-19T16:03:43.000+05:30')
    expect(outcome.text).not.toContain('10:33')
  })
})

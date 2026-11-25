/**
 * How long a bot's browser stays open once its last run let go of it (no browser: a scripted browser service, timers
 * fired by hand): `BOT_BROWSER_IDLE_MS` after an ordinary end, `BOT_BROWSER_HANDOFF_IDLE_MS` when that work waits for its
 * owner. While the owner watches or holds it, the wait starts again at the same length. A shorter wait never cuts a
 * longer one short; a longer one replaces a shorter.
 *
 * Inputs: how the last activation ended (ordinary, waiting for its owner); what the owner does when the wait ends
 * (nothing, holds the browser); a second activation ending later with a shorter wait (before or after the longer one
 * would end).
 */
import { describe, expect, it } from 'vitest'
import { BOT_BROWSER_HANDOFF_IDLE_MS, BOT_BROWSER_IDLE_MS, BotBrowsers, type BotBrowserService } from '../../src/mms/bots/browser/BotBrowsers'
import { dispatchBrowserTool } from '../../src/mms/orchestrator/browser/dispatch'
import type { BrowserSessionRecord } from '../../src/shared/browser/types'

const profileId = '55555555-5555-4555-8555-555555555555'
const BOT = 'bot-idleidleidle'
const MINUTE = 60_000

/** A bot's browser over a scripted service, with its clock and its timers in the test's hands. */
function host() {
  let now = Date.parse('2026-11-26T09:00:00Z')
  let record: BrowserSessionRecord | undefined
  const closed: string[] = []
  const service = {
    tools: {
      invoke: async (name: string, args: Record<string, unknown>) => {
        if (name === 'browser_open') {
          record = { id: 'sess_1', profileId, threadId: 'home', persistent: true, workspaceId: String(args.workspaceId), backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'agent-controlled', controlLeaseId: 'lease_1', createdAt: '', updatedAt: '' }
          return { ok: true, value: { session: record, observation: { tabId: 'tab_1', sessionId: 'sess_1' } } }
        }
        return { ok: true, value: { observation: { tabId: 'tab_1', sessionId: 'sess_1' } } }
      }
    },
    sessions: {
      trustedSessionScope: () => { if (!record) throw new Error('none'); return { threadId: 'home', record } },
      retireViewerBudget: () => {},
      close: async (_context: unknown, sessionId: string) => { closed.push(sessionId); if (record) record.lifecycle = 'closed' }
    },
    artifacts: {},
    workspaceDataDir: () => '/nonexistent'
  } as unknown as BotBrowserService
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean; fired: boolean }> = []
  const bots = new BotBrowsers({
    profileId,
    browser: () => service,
    homeThread: () => 'home',
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, fired: false }
      timers.push(timer)
      return { clear: () => { timer.cleared = true } }
    }
  })
  /** The idle waits still armed. */
  const armed = () => timers.filter((timer) => !timer.cleared && !timer.fired)
  return {
    bots,
    closed,
    armed,
    advance: (ms: number) => { now += ms },
    /** The owner takes the browser over (or gives it back). */
    hold: (held: boolean) => { record!.lifecycle = held ? 'human-controlled' : 'agent-controlled' },
    /** The one armed wait runs out. */
    fire: async () => {
      const [timer, ...more] = armed()
      expect(more).toEqual([])
      timer!.fired = true
      timer!.fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    /** An activation's browser for one turn; `open` uses it to open a page. */
    turn: async (activationId: string, open = false) => {
      const turn = bots.turn({ botId: BOT, activationId, lane: 'run', homeThreadId: 'home', runId: `run-${activationId}`, signal: new AbortController().signal })!
      if (open) expect((await dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name: 'browser_open', args: { url: 'https://example.com/' } })).isError).toBe(false)
    },
    end: (activationId: string, waitingForOwner?: boolean) => bots.activationEnded({ botId: BOT, activationId, ...(waitingForOwner ? { waitingForOwner } : {}) })
  }
}

describe("a bot's browser after its last run", () => {
  it.each([
    { ended: 'an ordinary end', waitingForOwner: false, waitMs: BOT_BROWSER_IDLE_MS },
    { ended: 'work waiting for its owner', waitingForOwner: true, waitMs: BOT_BROWSER_HANDOFF_IDLE_MS }
  ])('after $ended stays open for its wait, longer while the owner holds it, then closes', async ({ waitingForOwner, waitMs }) => {
    expect(BOT_BROWSER_HANDOFF_IDLE_MS).toBeGreaterThan(BOT_BROWSER_IDLE_MS)
    const h = host()
    await h.turn('act-1', true)
    h.end('act-1', waitingForOwner)
    expect(h.armed().map((timer) => timer.ms)).toEqual([waitMs])
    // The owner holds it when the wait ends: it stays, for the same wait again.
    h.hold(true)
    h.advance(waitMs)
    await h.fire()
    expect(h.closed).toEqual([])
    expect(h.armed().map((timer) => timer.ms)).toEqual([waitMs])
    // Given back, it closes when that wait ends.
    h.hold(false)
    h.advance(waitMs)
    await h.fire()
    expect(h.closed).toEqual(['sess_1'])
  })

  it('a shorter wait never cuts a waiting-for-owner one short; one that ends later replaces it', async () => {
    const h = host()
    await h.turn('asks', true)
    h.end('asks', true)
    const handoff = h.armed()[0]!
    // Another run ends 5 minutes later: its 10 minutes would end before the 30, so the 30 stay.
    h.advance(5 * MINUTE)
    await h.turn('quick')
    h.end('quick')
    expect(h.armed()).toEqual([handoff])
    // Another ends 25 minutes in: its 10 minutes end after the 30, so they replace them.
    h.advance(20 * MINUTE)
    await h.turn('late')
    h.end('late')
    expect(handoff.cleared).toBe(true)
    expect(h.armed().map((timer) => timer.ms)).toEqual([BOT_BROWSER_IDLE_MS])
    await h.fire()
    expect(h.closed).toEqual(['sess_1'])
  })
})

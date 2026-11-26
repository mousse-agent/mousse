/**
 * How long a bot's browser stays open once its last run let go of it, and what happens to the page of work that waits for
 * its owner (no browser: a scripted browser service, timers fired by hand): `BOT_BROWSER_IDLE_MS` after an ordinary end,
 * `BOT_BROWSER_HANDOFF_IDLE_MS` when that work waits for its owner. While the owner watches or holds it, the wait starts
 * again at the same length. A shorter wait never cuts a longer one short; a longer one replaces a shorter; a wait that is
 * over (its work went on, or was stopped) no longer counts.
 *
 * Inputs: how the last activation ended (ordinary, waiting for its owner); what the owner does when the wait ends
 * (nothing, holds the browser); a second activation ending later with a shorter wait (before or after the longer one
 * would end); work waiting for its owner while another run is still browsing, or browses and ends meanwhile; that work
 * going on (with its tabs still open, or one closed meanwhile), or stopped while it waits.
 */
import { describe, expect, it } from 'vitest'
import { BOT_BROWSER_HANDOFF_IDLE_MS, BOT_BROWSER_IDLE_MS, BotBrowsers, type BotBrowserService } from '../../src/mms/bots/browser/BotBrowsers'
import { dispatchBrowserTool } from '../../src/mms/orchestrator/browser/dispatch'
import type { BrowserAutomationTool } from '../../src/shared/browser/automation'
import type { BrowserSessionRecord } from '../../src/shared/browser/types'

const profileId = '55555555-5555-4555-8555-555555555555'
const BOT = 'bot-idleidleidle'
const MINUTE = 60_000

/** A bot's browser over a scripted service, with its clock and its timers in the test's hands. */
function host() {
  let now = Date.parse('2026-11-26T09:00:00Z')
  let record: BrowserSessionRecord | undefined
  const closed: string[] = []
  /** The session's open tabs, the tabs closed, and the tab each observation was asked of. */
  const tabs = new Set<string>()
  const closedTabs: string[] = []
  const observed: Array<string | undefined> = []
  let nextTab = 1
  const service = {
    tools: {
      invoke: async (name: string, args: Record<string, unknown>) => {
        if (name === 'browser_open') {
          record = { id: 'sess_1', profileId, threadId: 'home', persistent: true, workspaceId: String(args.workspaceId), backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'agent-controlled', controlLeaseId: 'lease_1', createdAt: '', updatedAt: '' }
          const tabId = `tab_${nextTab++}`
          tabs.add(tabId)
          return { ok: true, value: { session: record, observation: { tabId, sessionId: 'sess_1' } } }
        }
        if (name === 'browser_tabs' && args.operation === 'new') {
          const tabId = `tab_${nextTab++}`
          tabs.add(tabId)
          return { ok: true, value: { tab: { id: tabId } } }
        }
        if (name === 'browser_tabs') return { ok: true, value: { tabs: [...tabs].map((id) => ({ id })) } }
        const tabId = typeof args.tabId === 'string' ? args.tabId : undefined
        observed.push(tabId)
        return { ok: true, value: { observation: { tabId: tabId ?? 'front', sessionId: 'sess_1' } } }
      }
    },
    sessions: {
      trustedSessionScope: () => { if (!record) throw new Error('none'); return { threadId: 'home', record } },
      retireViewerBudget: () => {},
      tabs: async (_context: unknown, _sessionId: string, input: { operation: string; tabId: string }) => {
        if (input.operation === 'close' && tabs.delete(input.tabId)) closedTabs.push(input.tabId)
        return {}
      },
      close: async (_context: unknown, sessionId: string) => { closed.push(sessionId); tabs.clear(); if (record) record.lifecycle = 'closed' }
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
  const turns = new Map<string, NonNullable<ReturnType<BotBrowsers['turn']>>>()
  return {
    bots,
    closed,
    tabs,
    closedTabs,
    observed,
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
      turns.set(activationId, turn)
      if (open) expect((await dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name: 'browser_open', args: { url: 'https://example.com/' } })).isError).toBe(false)
    },
    /** One browser call of the activation's latest turn, as its model makes it. */
    call: (activationId: string, name: BrowserAutomationTool, args: Record<string, unknown> = {}) => {
      const turn = turns.get(activationId)!
      return dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name, args })
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

describe('work that waits for its owner, beside other runs', () => {
  it("keeps its page and its wait while another run browses and ends; the other run's tab closes", async () => {
    const h = host()
    await h.turn('asks', true)
    await h.turn('other', true)
    expect([...h.tabs]).toEqual(['tab_1', 'tab_2'])
    // It asks its owner while the other run still browses: its tab stays, and nothing waits to close the browser yet.
    h.end('asks', true)
    expect(h.closedTabs).toEqual([])
    expect(h.armed()).toEqual([])
    // Two minutes later the other run reads its page and ends as usual.
    h.advance(2 * MINUTE)
    expect((await h.call('other', 'browser_observe')).isError).toBe(false)
    h.end('other')
    await expect.poll(() => h.closedTabs).toEqual(['tab_2'])
    // The browser stays open for the rest of the work's thirty minutes, not the other run's ten.
    expect(h.armed().map((timer) => timer.ms)).toEqual([BOT_BROWSER_HANDOFF_IDLE_MS - 2 * MINUTE])
    expect([...h.tabs]).toEqual(['tab_1'])
  })

  it('a run that browses and ends while the work waits never shortens its wait; once the work went on, its next end waits as usual', async () => {
    const h = host()
    await h.turn('asks', true)
    h.end('asks', true)
    // Five minutes in another run uses the browser (its call stops the wait) and ends: the work's wait comes back whole.
    h.advance(5 * MINUTE)
    await h.turn('other', true)
    expect(h.armed()).toEqual([])
    h.end('other')
    expect(h.armed().map((timer) => timer.ms)).toEqual([BOT_BROWSER_HANDOFF_IDLE_MS - 5 * MINUTE])
    // The owner answers at minute 6, the work goes on, and finishes at minute 7: ten minutes from then, not what was left of thirty.
    h.advance(MINUTE)
    await h.turn('asks')
    h.advance(MINUTE)
    h.end('asks')
    expect(h.armed().map((timer) => timer.ms)).toEqual([BOT_BROWSER_IDLE_MS])
  })

  it('stopped while it waits, its page goes and the ordinary wait counts', async () => {
    const h = host()
    await h.turn('asks', true)
    await h.turn('other', true)
    h.end('asks', true)
    // Stopped while the other run still browses: its tab closes now.
    h.end('asks')
    await expect.poll(() => h.closedTabs).toEqual(['tab_1'])
    h.end('other')
    expect(h.armed().map((timer) => timer.ms)).toEqual([BOT_BROWSER_IDLE_MS])

    // Alone: stopped a minute after it asked, the browser closes ten minutes from then.
    const alone = host()
    await alone.turn('asks', true)
    alone.end('asks', true)
    alone.advance(MINUTE)
    alone.end('asks')
    expect(alone.armed().map((timer) => timer.ms)).toEqual([BOT_BROWSER_IDLE_MS])
  })

  it('goes on with the tabs it left its owner that are still open; work that let go of the browser otherwise opens its own again', async () => {
    const h = host()
    await h.turn('asks', true)
    expect((await h.call('asks', 'browser_tabs', { operation: 'new', url: 'https://example.com/2' })).isError).toBe(false)
    await h.turn('other', true)
    h.end('asks', true)
    // The owner closes the work's second tab while it waits.
    h.tabs.delete('tab_2')
    await h.turn('asks')
    // Its next observation looks at its first tab, the one still open; the closed one is no longer its.
    expect((await h.call('asks', 'browser_observe')).isError).toBe(false)
    expect(h.observed.at(-1)).toBe('tab_1')
    expect((await h.call('asks', 'browser_observe', { tabId: 'tab_2' })).text).toMatch(/another of your runs/)
    // The control: work that let go of the browser to wait for room has no tab of its own when it goes on.
    h.end('other')
    await expect.poll(() => h.closedTabs).toEqual(['tab_3'])
    await h.turn('other')
    const listed = await h.call('other', 'browser_tabs', { operation: 'list' })
    expect(JSON.parse(listed.text).tabs).toEqual([])
    // While the work that went on lists its tab.
    expect(JSON.parse((await h.call('asks', 'browser_tabs', { operation: 'list' })).text).tabs).toEqual([{ id: 'tab_1' }])
  })
})

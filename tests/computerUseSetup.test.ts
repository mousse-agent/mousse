/**
 * The setup card `computer_use_request` opens: the tool answers at once with an outcome line (ready, setup needed, or
 * declined), the card shows in the asking thread (a bot's chat for any of its turns), and nothing a Stop, a Not now or a
 * newer request overtook while the driver was being looked at ever shows a card. The card's methods stay on this computer
 * and only a window answers it.
 */
import { describe, expect, it, vi } from 'vitest'
import { ComputerUseSetupRequests, type ComputerUseSetupHost } from '../src/mms/computerUse/ComputerUseSetupRequests'
import { registerComputerUseMethods } from '../src/mms/computerUse/registerMethods'
import type { ComputerUseDriver } from '../src/mms/computerUse/ComputerUseDriver'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import {
  COMPUTER_USE_OUTCOME_MAX,
  extractComputerUseRequestOutcome,
  isComputerUseRequestCall,
  parseComputerUseOutcome,
  type ComputerUseStatus
} from '../src/shared/computerUse'

const found: ComputerUseStatus = { state: 'found', enabled: true, installable: true, source: 'default', path: '/bin/cua-driver' }
const missing: ComputerUseStatus = { state: 'missing', enabled: true, installable: true }

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

function setup(opts: { status?: ComputerUseStatus | (() => Promise<ComputerUseStatus>); enabled?: boolean; homes?: Record<string, string>; hostName?: string } = {}) {
  const state = { enabled: opts.enabled ?? true, status: opts.status ?? missing }
  const host: ComputerUseSetupHost = {
    status: vi.fn(async () => (typeof state.status === 'function' ? await state.status() : state.status)),
    enabled: () => state.enabled,
    hostName: () => opts.hostName ?? 'Ada',
    targetOf: (threadId) => opts.homes?.[threadId] ?? threadId,
    now: () => new Date('2026-11-25T10:00:00Z')
  }
  const store = new ComputerUseSetupRequests(host)
  const changes: string[] = []
  store.on('changed', ({ threadId }: { threadId: string }) => changes.push(threadId))
  return { store, state, host, changes }
}

describe('what computer_use_request answers, and the card it leaves', () => {
  // The inputs: the driver (found, missing, being installed, broken, a chosen file), the switch, a Not now standing,
  // a bot's turn, and what overtakes the look at the driver (a Stop, a Not now, a newer request).
  it.each([
    ['on and found', { status: found, enabled: true }, 'ready', false, /set up on Ada/],
    ['found but off', { status: found, enabled: false }, 'setup_needed', true, /needs turning on/],
    ['missing', { status: missing }, 'setup_needed', true, /needs installing/],
    ['missing and off', { status: missing, enabled: false }, 'setup_needed', true, /needs installing and turn computer use on/],
    ['being installed', { status: { ...missing, state: 'installing' } as ComputerUseStatus }, 'setup_needed', true, /being installed/],
    ['broken', { status: { ...found, state: 'broken' } as ComputerUseStatus }, 'setup_needed', true, /didn't start/],
    ['a chosen file that is missing', { status: { ...missing, source: 'chosen' } as ComputerUseStatus }, 'setup_needed', true, /chosen in Settings/],
    ['no installer here', { status: { ...missing, installable: false } }, 'setup_needed', true, /by hand/]
  ] as const)('%s → %s', async (_name, opts, outcome, card, words) => {
    const { store } = setup(opts)
    const result = await store.request({ threadId: 't1', reason: 'Open Figma' })
    expect(result.isError).toBeUndefined()
    expect(extractComputerUseRequestOutcome(result.text)).toBe(result.text)
    expect(parseComputerUseOutcome(result.text)).toMatchObject({ outcome })
    expect(result.text).toMatch(words)
    expect(Boolean(store.peek('t1'))).toBe(card)
  })

  it("keeps the card's reason to one bounded line and files a bot's request under its chat", async () => {
    const { store, changes } = setup({ homes: { 'bot-run': 'bot-home' } })
    await store.request({ threadId: 'bot-run', reason: `Open\nFigma ${'x'.repeat(400)}` })
    expect(store.peek('bot-run')).toBeUndefined()
    const card = store.peek('bot-home')!
    expect(card).toMatchObject({ threadId: 'bot-home', originThreadId: 'bot-run', hostName: 'Ada', createdAt: '2026-11-25T10:00:00.000Z' })
    expect(card.reason.startsWith('Open Figma x')).toBe(true)
    expect(card.reason.length).toBe(240)
    expect(changes).toEqual(['bot-home'])
  })

  it('after Not now says declined without a card, until computer use settings change', async () => {
    const { store } = setup()
    await store.request({ threadId: 't1', reason: 'Open Figma' })
    const { requestId } = store.peek('t1')!
    expect(store.dismiss('t1', 'cur_other')).toBe(false)
    expect(store.peek('t1')).toBeDefined()
    expect(store.dismiss('t1', requestId)).toBe(true)
    expect(store.peek('t1')).toBeUndefined()
    expect(parseComputerUseOutcome((await store.request({ threadId: 't1', reason: 'again' })).text)?.outcome).toBe('declined')
    expect(store.peek('t1')).toBeUndefined()
    store.settingsChanged()
    expect(parseComputerUseOutcome((await store.request({ threadId: 't1', reason: 'again' })).text)?.outcome).toBe('setup_needed')
  })

  it('closes an open card once computer use is on and the driver runs', async () => {
    const { store, state, changes } = setup()
    await store.request({ threadId: 't1', reason: 'Open Figma' })
    expect(await store.get('t1')).toBeDefined()
    state.status = found
    expect(await store.get('t1')).toBeUndefined()
    expect(store.peek('t1')).toBeUndefined()
    expect(changes).toEqual(['t1', 't1'])
  })

  describe('while the driver is being looked at', () => {
    function held() {
      const looks: Array<Deferred<ComputerUseStatus>> = []
      const s = setup({ status: () => { const look = deferred<ComputerUseStatus>(); looks.push(look); return look.promise } })
      return { ...s, looks }
    }

    it('a Stop shows no card and the call says it stopped', async () => {
      const { store, looks, changes } = held()
      const stop = new AbortController()
      const call = store.request({ threadId: 't1', reason: 'Open Figma', signal: stop.signal })
      await vi.waitFor(() => expect(looks).toHaveLength(1))
      stop.abort()
      looks[0]!.resolve(missing)
      const result = await call
      expect(result).toMatchObject({ isError: true })
      expect(parseComputerUseOutcome(result.text)).toBeUndefined()
      expect(store.peek('t1')).toBeUndefined()
      expect(changes).toEqual([])
    })

    it('a Not now wins: no card comes back and the call says declined', async () => {
      const { store, looks } = held()
      const call = store.request({ threadId: 't1', reason: 'Open Figma' })
      await vi.waitFor(() => expect(looks).toHaveLength(1))
      store.dismiss('t1')
      looks[0]!.resolve(missing)
      expect(parseComputerUseOutcome((await call).text)?.outcome).toBe('declined')
      expect(store.peek('t1')).toBeUndefined()
    })

    it('a newer request wins: the older one publishes nothing, even when its look ends last', async () => {
      const { store, looks } = held()
      const older = store.request({ threadId: 't1', reason: 'older' })
      await vi.waitFor(() => expect(looks).toHaveLength(1))
      const newer = store.request({ threadId: 't1', reason: 'newer' })
      await vi.waitFor(() => expect(looks).toHaveLength(2))
      looks[1]!.resolve(missing)
      expect(parseComputerUseOutcome((await newer).text)?.outcome).toBe('setup_needed')
      looks[0]!.resolve(missing)
      expect(parseComputerUseOutcome((await older).text)).toBeUndefined()
      expect(store.peek('t1')?.reason).toBe('newer')
    })
  })
})

describe('the outcome line', () => {
  it('keeps the host name to one bounded part and reads it back', async () => {
    const { store } = setup({ hostName: `Ada's [Mac]:\nStudio ${'y'.repeat(200)}` })
    const { text } = await store.request({ threadId: 't1', reason: 'Open Figma' })
    expect(text.length).toBeLessThanOrEqual(COMPUTER_USE_OUTCOME_MAX)
    expect(text).not.toMatch(/\n/)
    const parsed = parseComputerUseOutcome(text)!
    expect(parsed.outcome).toBe('setup_needed')
    expect(parsed.hostName!.length).toBeLessThanOrEqual(64)
    expect(parsed.hostName!.startsWith("Ada's Mac Studio")).toBe(true)
  })

  it.each([
    ['a ready line', '[computer-use:ready] Computer use is set up on Ada.', '[computer-use:ready] Computer use is set up on Ada.'],
    ['leading blank lines', '\n  [computer-use:declined] Not now.\nmore', '[computer-use:declined] Not now.'],
    ['a marker not at the start', 'Note: [computer-use:ready] no', undefined],
    ['an unknown outcome', '[computer-use:installed] yes', undefined],
    ['no output', undefined, undefined]
  ] as const)('extracts %s', (_name, output, expected) => {
    expect(extractComputerUseRequestOutcome(output)).toBe(expected)
  })

  it.each([
    ['computer_use_request', undefined, true],
    ['mcp__mousse__computer_use_request', undefined, true],
    ['mcp_mousse_computer_use_request', undefined, true],
    ['mousse_0123456789ab_computer_use_request', undefined, true],
    ['mousse_0123456789ab_relay_computer_use_request', undefined, false],
    ['computer_use_request (mousse MCP Server)', undefined, true],
    ['use_tool', { tool: 'computer_use_request' }, true],
    ['mcp__mousse__use_tool', { tool: 'mcp__mousse__computer_use_request' }, true],
    ['use_tool', { tool: 'computer_use' }, false],
    ['computer_use', undefined, false],
    ['mcp__other__computer_use_request', undefined, false]
  ] as const)('%s %j is a setup request: %s', (name, input, expected) => {
    expect(isComputerUseRequestCall(name, input as Record<string, unknown> | undefined)).toBe(expected)
  })
})

describe('the setup card methods', () => {
  function methods() {
    const s = setup()
    const install = deferred<ComputerUseStatus>()
    let installing = false
    const driver = {
      status: vi.fn(async () => missing),
      isInstalling: () => installing,
      install: vi.fn(() => { installing = true; return install.promise.finally(() => { installing = false }) })
    } as unknown as ComputerUseDriver
    const domains = new DomainHandlerRegistry()
    registerComputerUseMethods(domains, async () => ({ driver, setup: s.store }))
    const call = (clientType: string, method: string, params: Record<string, unknown>) => domains.dispatch({
      connection: { id: 'conn-1', binding: { profileId: 'prf_1', epoch: 1 }, capabilities: new Set(), clientType, emitConnectionEvent: async () => undefined }
    } as unknown as HandlerContext, method, params)
    return { ...s, driver, install, call }
  }

  it("reads a thread's card, and only a window answers Not now", async () => {
    const m = methods()
    expect(await m.call('gui', 'computerUse.setupRequest.get', { threadId: 't1' })).toEqual({ request: null })
    await m.store.request({ threadId: 't1', reason: 'Open Figma' })
    const { request } = await m.call('cli', 'computerUse.setupRequest.get', { threadId: 't1' }) as { request: { requestId: string; reason: string } }
    expect(request.reason).toBe('Open Figma')
    await expect(m.call('cli', 'computerUse.setupRequest.dismiss', { threadId: 't1', requestId: request.requestId })).rejects.toMatchObject({ code: 'forbidden' })
    expect(m.store.peek('t1')).toBeDefined()
    expect(await m.call('gui', 'computerUse.setupRequest.dismiss', { threadId: 't1', requestId: request.requestId })).toEqual({ dismissed: true })
    expect(m.store.isDeclined('t1')).toBe(true)
    await expect(m.call('gui', 'computerUse.setupRequest.get', {})).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('tells every open card when an install starts and when it ends', async () => {
    const m = methods()
    await m.store.request({ threadId: 't1', reason: 'Open Figma' })
    m.changes.length = 0
    const first = m.call('gui', 'computerUse.install', {})
    await vi.waitFor(() => expect(m.changes).toEqual(['t1']))
    // A second click while it runs neither starts another installer nor tells the cards twice.
    const second = m.call('gui', 'computerUse.install', {})
    await vi.waitFor(() => expect(m.driver.install).toHaveBeenCalledTimes(2))
    expect(m.changes).toEqual(['t1'])
    m.install.resolve(found)
    await Promise.all([first, second])
    await vi.waitFor(() => expect(m.changes).toEqual(['t1', 't1']))
  })
})

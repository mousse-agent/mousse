/**
 * How a bot's browser pictures reach the app: `bots.browser.watch` and `unwatch` on the daemon's
 * connection, pushed as `bots.browser.frame` connection events to that connection alone. Only the
 * desktop app on this computer may watch; a connection can end only its own watch; a picture event
 * may be larger than other connection events, and no larger than its cap.
 */
import { describe, expect, it, vi } from 'vitest'
import { DomainHandlerRegistry, DomainRpcError } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { parseEnvelope } from '../src/mms/protocol/validators'
import { MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES, MMS_PROTOCOL_MAX_FRAME_EVENT_BYTES } from '../src/mms/protocol/types'
import { registerBotBrowserMethods } from '../src/mms/bots/browser/registerBotBrowserMethods'
import type { BotBrowsers } from '../src/mms/bots/browser/BotBrowsers'
import { BOTS_BROWSER_STREAM_CAPABILITY } from '../src/shared/bots/personal/browser'

const BOT = 'bot-aaaaaaaaaaaa'

function setup() {
  const watch = vi.fn(async () => ({ open: true, control: 'bot' as const, activations: [] }))
  const unwatch = vi.fn()
  const browsers = { watch, unwatch } as unknown as BotBrowsers
  const domains = new DomainHandlerRegistry()
  registerBotBrowserMethods(domains, () => browsers)
  domains.seal()
  const emitted: Array<[string, unknown]> = []
  const connection = (overrides: Record<string, unknown> = {}) => ({
    id: 'conn-1',
    binding: { profileId: 'p1', epoch: 1 },
    capabilities: new Set<string>(),
    clientType: 'gui',
    lifetime: new AbortController().signal,
    emitConnectionEvent: vi.fn(async (type: string, data: unknown) => { emitted.push([type, data]) }),
    ...overrides
  })
  const call = (method: string, params: unknown, conn = connection()) =>
    domains.dispatch({ connection: conn } as unknown as HandlerContext, method, params)
  return { domains, watch, unwatch, emitted, connection, call }
}

describe('watching a bot\'s browser over the daemon protocol', () => {
  it('offers watch under its own capability', () => {
    expect(setup().domains.capabilities()).toContain(BOTS_BROWSER_STREAM_CAPABILITY)
  })

  it('watches for the desktop app\'s own connection, and pushes pictures to that connection only', async () => {
    const { watch, unwatch, emitted, call } = setup()
    expect(await call('bots.browser.watch', { botId: BOT, watchId: 'w1', width: 480, fps: 5 })).toMatchObject({ browser: { open: true } })
    expect(watch).toHaveBeenCalledWith(BOT, 'w1', expect.objectContaining({ width: 480, fps: 5, connectionId: 'conn-1' }))
    const viewer = (watch.mock.calls[0] as unknown[])[2] as { emit(event: unknown): Promise<void> }
    await viewer.emit({ botId: BOT, watchId: 'w1', frame: { data: 'AAAA' } })
    expect(emitted).toEqual([['bots.browser.frame', { botId: BOT, watchId: 'w1', frame: { data: 'AAAA' } }]])
    // A connection ends only its own watch.
    await call('bots.browser.unwatch', { botId: BOT, watchId: 'w1' })
    expect(unwatch).toHaveBeenCalledWith(BOT, 'w1', 'conn-1')
  })

  it('refuses a watch from anything but the desktop app on this computer, and bad parameters', async () => {
    const { watch, call, connection } = setup()
    await expect(call('bots.browser.watch', { botId: BOT, watchId: 'w1', width: 480, fps: 5 }, connection({ clientType: 'cli' }))).rejects.toMatchObject({ code: 'unsupported' })
    await expect(call('bots.browser.watch', { botId: BOT, watchId: 'w1', width: 480, fps: 5 }, connection({ bridgeCaller: { node: 'n', user: 'u', maxPermissionMode: 'ask' } }))).rejects.toMatchObject({ code: 'unsupported' })
    await expect(call('bots.browser.watch', { botId: BOT, watchId: 'w1', width: 480, fps: 5 }, connection({ emitConnectionEvent: undefined }))).rejects.toBeInstanceOf(DomainRpcError)
    await expect(call('bots.browser.watch', { botId: BOT, watchId: 'bad id', width: 480, fps: 5 })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('bots.browser.watch', { botId: BOT, watchId: 'w1', width: 480 })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('bots.browser.watch', { botId: BOT, watchId: 'w1', width: 480, fps: 5, extra: true })).rejects.toBeInstanceOf(DomainRpcError)
    expect(watch).not.toHaveBeenCalled()
  })

  it('takes a picture event up to its own cap, and keeps every other connection event to the smaller one', () => {
    const event = (type: string, bytes: number) => ({ kind: 'connection_event', type, profileId: 'p1', profileEpoch: 1, data: { frame: { data: 'A'.repeat(bytes) } } })
    expect(parseEnvelope(event('bots.browser.frame', 500 * 1024))).toMatchObject({ kind: 'connection_event', type: 'bots.browser.frame' })
    expect(parseEnvelope(event('bots.browser.frame', MMS_PROTOCOL_MAX_FRAME_EVENT_BYTES))).toBeNull()
    expect(parseEnvelope(event('git.operation', MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES))).toBeNull()
    expect(parseEnvelope(event('bots.browser.other', 10))).toBeNull()
  })
})

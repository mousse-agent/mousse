/**
 * How a bot's browser pictures reach the app: `bots.browser.watch` and `unwatch` on the daemon's
 * connection, pushed as `bots.browser.frame` connection events to that connection alone. Only the
 * desktop app on this computer may watch, take the browser over, send input, take a fresh picture,
 * close it, or give a page files (and that last one is not a method the renderer's bridge offers);
 * a hold and its input name the calling connection; files never come as paths on the input channel.
 * A connection can end only its own watch; a picture event may be larger than other connection events,
 * and no larger than its cap.
 */
import { describe, expect, it, vi } from 'vitest'
import { DomainHandlerRegistry, DomainRpcError } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { parseEnvelope } from '../src/mms/protocol/validators'
import { MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES, MMS_PROTOCOL_MAX_FRAME_EVENT_BYTES } from '../src/mms/protocol/types'
import { registerBotBrowserMethods } from '../src/mms/bots/browser/registerBotBrowserMethods'
import type { BotBrowsers } from '../src/mms/bots/browser/BotBrowsers'
import { BOT_BROWSER_FILES_METHOD, BOTS_BROWSER_METHODS, BOTS_BROWSER_STREAM_CAPABILITY } from '../src/shared/bots/personal/browser'

const BOT = 'bot-aaaaaaaaaaaa'

function setup() {
  const watch = vi.fn(async () => ({ open: true, control: 'bot' as const, activations: [] }))
  const unwatch = vi.fn()
  const view = vi.fn(async () => ({ open: true, control: 'bot' as const, activations: [] }))
  const close = vi.fn(async () => ({ open: false, control: 'bot' as const, activations: [] }))
  const hold = vi.fn(async () => ({ browser: { open: true, control: 'owner' as const, activations: [] }, hold: { id: 'hold_1', lastSeq: 0, computer: 'Desk' } }))
  const send = vi.fn(async () => ({ acks: [], lastSeq: 0 }))
  const chooseFiles = vi.fn(async () => ({ token: 'files_0123456789ab', count: 1 }))
  const browsers = { watch, unwatch, view, close, hold, send, chooseFiles } as unknown as BotBrowsers
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
  return { domains, watch, unwatch, view, close, hold, send, chooseFiles, emitted, connection, call }
}

/** Callers that are not the desktop app on this computer: a CLI, a bridged call from another computer. */
const strangers = (connection: ReturnType<typeof setup>['connection']) => [connection({ clientType: 'cli' }), connection({ bridgeCaller: { node: 'n', user: 'u', maxPermissionMode: 'ask' } })]

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

  it('takes a hold and its input from the desktop app alone, on the calling connection; refuses anyone else', async () => {
    const { hold, send, call, connection } = setup()
    for (const stranger of strangers(connection)) {
      await expect(call('bots.browser.hold', { botId: BOT, viewId: 'view-1', request: { op: 'take' } }, stranger)).rejects.toMatchObject({ code: 'unsupported' })
      await expect(call('bots.browser.send', { botId: BOT, viewId: 'view-1', holdId: 'hold_1', inputs: [{ seq: 1, input: { kind: 'type', text: 'x' } }] }, stranger)).rejects.toMatchObject({ code: 'unsupported' })
    }
    expect(hold).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    await call('bots.browser.hold', { botId: BOT, viewId: 'view-1', request: { op: 'take', platform: 'mac' } })
    expect(hold).toHaveBeenCalledWith(BOT, 'view-1', { op: 'take', platform: 'mac' }, 'conn-1')
    await call('bots.browser.send', { botId: BOT, viewId: 'view-1', holdId: 'hold_1', inputs: [{ seq: 1, skip: true }, { seq: 2, picture: 4, input: { kind: 'files', token: 'files_0123456789ab' } }] })
    expect(send).toHaveBeenCalledWith(BOT, 'view-1', 'hold_1', [{ seq: 1, skip: true }, { seq: 2, picture: 4, input: { kind: 'files', token: 'files_0123456789ab' } }], 'conn-1')
  })

  it('never takes paths on the input channel, nor an input the page never takes', async () => {
    const { send, call } = setup()
    await expect(call('bots.browser.send', { botId: BOT, viewId: 'view-1', holdId: 'hold_1', inputs: [{ seq: 1, input: { kind: 'files', paths: ['/etc/passwd'] } }] })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('bots.browser.send', { botId: BOT, viewId: 'view-1', holdId: 'hold_1', inputs: [{ seq: 1, input: { kind: 'dialog', accept: true, text: 'x'.repeat(4_097) } }] })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('bots.browser.input', { botId: BOT, input: { kind: 'files', token: 'files_0123456789ab' } })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(send).not.toHaveBeenCalled()
  })

  it('gives a fresh picture and closes the browser for the desktop app alone; its state is read by any caller of the profile', async () => {
    const { view, close, call, connection } = setup()
    for (const stranger of strangers(connection)) {
      await expect(call('bots.browser.get', { botId: BOT, frame: true }, stranger)).rejects.toMatchObject({ code: 'unsupported' })
      await expect(call('bots.browser.close', { botId: BOT }, stranger)).rejects.toMatchObject({ code: 'unsupported' })
    }
    expect(view).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    await call('bots.browser.get', { botId: BOT }, connection({ clientType: 'cli' }))
    expect(view).toHaveBeenCalledWith(BOT, { frame: false, connectionId: 'conn-1' })
    await call('bots.browser.get', { botId: BOT, frame: true, viewId: 'view-1' })
    expect(view).toHaveBeenLastCalledWith(BOT, { frame: true, viewId: 'view-1', connectionId: 'conn-1' })
    await call('bots.browser.close', { botId: BOT })
    expect(close).toHaveBeenCalledWith(BOT)
  })

  it('takes chosen files from the desktop app alone, as a method the renderer\'s bridge does not offer', async () => {
    const { chooseFiles, call, connection } = setup()
    expect((BOTS_BROWSER_METHODS as readonly string[]).includes(BOT_BROWSER_FILES_METHOD)).toBe(false)
    const params = { botId: BOT, viewId: 'view-1', holdId: 'hold_1', paths: ['/Users/me/note.txt'] }
    for (const stranger of strangers(connection)) await expect(call(BOT_BROWSER_FILES_METHOD, params, stranger)).rejects.toMatchObject({ code: 'unsupported' })
    await expect(call(BOT_BROWSER_FILES_METHOD, { ...params, paths: Array(17).fill('/a') })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(await call(BOT_BROWSER_FILES_METHOD, params)).toEqual({ token: 'files_0123456789ab', count: 1 })
    expect(chooseFiles).toHaveBeenCalledWith(BOT, 'view-1', 'hold_1', ['/Users/me/note.txt'], 'conn-1')
  })

  it('takes a picture event up to its own cap, and keeps every other connection event to the smaller one', () => {
    const event = (type: string, bytes: number) => ({ kind: 'connection_event', type, profileId: 'p1', profileEpoch: 1, data: { frame: { data: 'A'.repeat(bytes) } } })
    expect(parseEnvelope(event('bots.browser.frame', 500 * 1024))).toMatchObject({ kind: 'connection_event', type: 'bots.browser.frame' })
    expect(parseEnvelope(event('bots.browser.frame', MMS_PROTOCOL_MAX_FRAME_EVENT_BYTES))).toBeNull()
    expect(parseEnvelope(event('git.operation', MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES))).toBeNull()
    expect(parseEnvelope(event('bots.browser.other', 10))).toBeNull()
  })
})

/**
 * A bot's browser watched from another computer (`docs/plans/remote-bots.md`, live view): one `mousse.botview` stream
 * per view on screen, pictures under the stream's credit with stale ones dropped, the view gone at once when the device
 * loses its reach, and takeover kept for Full.
 */
import { describe, expect, it, vi } from 'vitest'
import { newId, NetError, type NodeId } from '../../../../src/shared/net'
import type { BotLevel } from '../../../../src/shared/net/local'
import type { BotBrowserFrameEvent, BotBrowserView } from '../../../../src/shared/bots/personal/browser'
import { RemoteBotBrowsers, REMOTE_VIEW_MAX_FPS, REMOTE_VIEW_MAX_WIDTH, type RemoteBrowsersPort } from '../../../../src/mms/bridge/remote/RemoteBotBrowsers'
import { remoteBotMethods, type RemoteBotsPort } from '../../../../src/mms/bridge/remote/RemoteBots'
import { RemoteBotViews } from '../../../../src/mms/bridge/routed/remoteBotViews'
import type { EngineStream } from '../../../../src/mms/netEngine/session/transport'
import type { RpcContext, RpcMethod } from '../../../../src/mms/net/contracts'
import { fakeLink } from '../../../netEngine/fakeLink'

const BOT = 'helper'
const VIEW = { open: true, control: 'bot', holder: 'bot', activations: [] } as unknown as BotBrowserView

/** The bots' browsers on the bot's computer: each watch's input and its `emit`, and a slot that holds the latest update. */
function browsers() {
  const watches: Array<{ botId: string; watchId: string; width: number; fps: number; connectionId: string; emit(event: BotBrowserFrameEvent): Promise<void> }> = []
  const unwatched: string[] = []
  const holds: string[] = []
  const ended: string[] = []
  /**
   * What `WatchedBrowser` does for each view: one update in flight, and while it is, only the newest waits (latest
   * wins). Each picture is numbered by its `at`.
   */
  const slot = { busy: false, next: undefined as BotBrowserFrameEvent | undefined }
  const push = (event: BotBrowserFrameEvent): void => {
    const watch = watches.at(-1)!
    if (slot.busy) {
      slot.next = event
      return
    }
    slot.busy = true
    void watch.emit(event).catch(() => undefined).finally(() => {
      slot.busy = false
      const next = slot.next
      slot.next = undefined
      if (next) push(next)
    })
  }
  const port: RemoteBrowsersPort = {
    view: async () => VIEW,
    watch: async (botId, watchId, input) => {
      watches.push({ botId, watchId, width: input.width, fps: input.fps, connectionId: input.connectionId, emit: input.emit })
      return VIEW
    },
    unwatch: (botId, watchId) => void unwatched.push(`${botId}/${watchId}`),
    hold: async (botId, _viewId, request, connectionId) => {
      holds.push(`${botId} ${request.op} ${connectionId}`)
      return { browser: VIEW, hold: { id: 'hold_1', lastSeq: 0, computer: 'Owner' } }
    },
    send: async () => ({ acks: [], lastSeq: 0 }),
    open: async () => ({ browser: VIEW }),
    endHoldsOf: async (botId, connectionId) => void ended.push(`${botId} ${connectionId}`)
  }
  return { port, watches, unwatched, holds, ended, push }
}

/** A picture of `bytes` bytes, numbered `at`. */
const picture = (at: number, bytes = 1000): BotBrowserFrameEvent => ({
  botId: BOT,
  watchId: 'w1',
  frame: { data: Buffer.alloc(bytes, at % 251).toString('base64'), mimeType: 'image/jpeg', width: 480, height: 300, at }
})

/**
 * The bot's computer and a viewer, over one link. `credit`: the stream the bot's computer writes pictures on takes
 * more only once it is let (`release`), as a stream out of the helper's credit does.
 */
function setup(options: { level?: BotLevel; credit?: boolean } = {}) {
  const viewerNode = newId('node') as NodeId
  const ownerNode = newId('node') as NodeId
  const link = fakeLink({ ownerOnCaller: ownerNode, callerOnOwner: viewerNode, grant: '1', endpoint: 'e' })
  const access = { level: options.level ?? 'full' as BotLevel, reach: true }
  const listeners = new Set<() => void>()
  const reach = {
    level: () => access.level,
    canReach: () => access.reach,
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const owner = browsers()
  const host = new RemoteBotBrowsers({ browsers: () => owner.port, bot: (botId) => { if (botId !== BOT) throw new Error('gone') }, reach })
  let gate: { promise: Promise<void>; release(): void } | undefined
  const credit = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => (release = resolve))
    gate = { promise, release: () => { release(); gate = credit() } }
    return gate
  }
  if (options.credit) credit()
  /** Each view's stream as the bot's computer has it. */
  const streams: EngineStream[] = []
  link.inbound.onStream((stream) => {
    streams.push(stream)
    const paced: EngineStream = options.credit
      ? {
          label: stream.label,
          write: (bytes) => stream.write(bytes),
          end: () => stream.end(),
          reset: (reason) => stream.reset(reason),
          ready: () => gate!.promise,
          onData: (listener) => stream.onData(listener),
          onEnd: (listener) => stream.onEnd(listener)
        }
      : stream
    host.accept(viewerNode, paced)
  })
  const shown: BotBrowserFrameEvent[] = []
  const window = { id: 'window-1', emit: (_type: string, data: unknown) => void shown.push(data as BotBrowserFrameEvent) }
  const viewer = new RemoteBotViews({
    open: () => link.outbound.open('mousse.botview'),
    online: () => link.outbound.isOpen(),
    computer: (node) => ({ node, name: 'Owner' })
  })
  return {
    link, host, viewer, owner, window, shown, ownerNode, viewerNode, streams,
    lose: (change: Partial<typeof access>) => {
      Object.assign(access, change)
      for (const listener of listeners) listener()
    },
    release: () => gate?.release()
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a bot’s browser watched from another computer', () => {
  it('opens a view’s stream while it is shown, sends its pictures whole within the remote size and rate, and closes it when hidden', async () => {
    const { link, host, viewer, owner, window, shown, ownerNode } = setup()
    expect(link.crossed.filter((row) => row.label === 'mousse.botview')).toEqual([])
    const answer = await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 3840, fps: 15 })
    expect(answer.browser).toMatchObject({ open: true })
    expect(owner.watches).toEqual([expect.objectContaining({ botId: BOT, watchId: 'w1', width: REMOTE_VIEW_MAX_WIDTH, fps: REMOTE_VIEW_MAX_FPS })])
    expect([viewer.viewCount, host.viewCount]).toEqual([1, 1])
    // A renewal goes on the same stream.
    await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5 })
    expect(link.crossed.filter((row) => row.label === 'mousse.botview' && row.header.t === 'watch')).toHaveLength(2)
    expect(host.viewCount).toBe(1)

    // A picture larger than one message crosses in parts and shows whole, under the bot's id here.
    const big = picture(1, 120 * 1024)
    await owner.watches[0]!.emit(big)
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    expect(shown[0]).toMatchObject({ botId: `${ownerNode}:${BOT}`, watchId: 'w1', frame: { width: 480, height: 300, at: 1 } })
    expect(shown[0]!.frame!.data).toBe(big.frame!.data)
    expect(link.crossed.filter((row) => row.label === 'mousse.botview' && row.header.t === 'part').length).toBeGreaterThan(0)

    // Hidden: the stream closes on both sides, and the browser stops picturing for it.
    viewer.unwatch(window.id, ownerNode, BOT, 'w1')
    await vi.waitFor(() => expect(owner.unwatched).toEqual([`${BOT}/w1`]))
    expect([viewer.viewCount, host.viewCount]).toEqual([0, 0])
    // Nothing tells the window it stalled: it asked for this.
    expect(shown.filter((event) => event.stalled)).toEqual([])
  })

  it('writes the next picture only once the last one left, so stale pictures are dropped under low credit', async () => {
    const { viewer, owner, window, shown, ownerNode, release } = setup({ credit: true })
    await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5 })
    // Five pictures while the stream takes nothing more: the first is on its way, only the newest waits.
    for (let at = 1; at <= 5; at += 1) {
      owner.push(picture(at))
      await settle()
    }
    expect(shown.map((event) => event.frame?.at)).toEqual([1])
    release()
    await vi.waitFor(() => expect(shown.map((event) => event.frame?.at)).toEqual([1, 5]))
    release()
    await settle()
    expect(shown.map((event) => event.frame?.at)).toEqual([1, 5])
  })

  it('ends the view at once when the device loses its reach, and refuses watching it again', async () => {
    const { host, viewer, owner, window, shown, ownerNode, lose } = setup({ level: 'use' })
    await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5 })
    lose({ reach: false })
    await vi.waitFor(() => expect(shown.at(-1)).toMatchObject({ botId: `${ownerNode}:${BOT}`, watchId: 'w1', stalled: 'forbidden' }))
    expect([viewer.viewCount, host.viewCount]).toEqual([0, 0])
    expect(owner.unwatched).toEqual([`${BOT}/w1`])
    // Its next renewal opens a stream that is refused as for a bot that is not there.
    await expect(viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5 })).rejects.toMatchObject({ code: 'stream_unknown' })
    // A device at Off is refused for its level.
    lose({ reach: true, level: 'off' })
    await expect(viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5 })).rejects.toMatchObject({ code: 'forbidden' })
    expect(owner.watches).toHaveLength(1)
  })

  it('refuses taking over below Full before the browser is asked, and ends a hold at once when Full goes', async () => {
    const owner = browsers()
    const access = { level: 'use' as BotLevel }
    const listeners = new Set<() => void>()
    const reach = { level: () => access.level, canReach: () => true, onChange: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)) }
    const host = new RemoteBotBrowsers({ browsers: () => owner.port, bot: () => undefined, reach })
    const bots = { get: () => ({}) } as unknown as RemoteBotsPort
    const methods = remoteBotMethods({ bots: () => bots, reach, browsers: host })
    const context = { caller: { node: 'viewer', user: 'u' } } as unknown as RpcContext
    const call = async (name: string, params: unknown): Promise<unknown> => {
      const method = methods.find((entry) => entry.method === name) as RpcMethod
      const valid = method.validate ? method.validate(params) : params
      method.authorize?.(valid, context)
      return method.handle(valid, context)
    }
    const take = { botId: BOT, viewId: 'v1', request: { op: 'take' } }
    await expect(call('bots.browser.hold', take)).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'bots_full_needed' } })
    await expect(call('bots.browser.send', { botId: BOT, viewId: 'v1', holdId: 'hold_1', inputs: [{ seq: 1, input: { kind: 'back' } }] })).rejects.toBeInstanceOf(NetError)
    await expect(call('bots.browser.open', { botId: BOT })).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'bots_full_needed' } })
    expect(owner.holds).toEqual([])
    // Its state is read at Use.
    await expect(call('bots.browser.get', { botId: BOT })).resolves.toMatchObject({ browser: { open: true } })

    access.level = 'full'
    await expect(call('bots.browser.hold', take)).resolves.toMatchObject({ hold: { id: 'hold_1' } })
    expect(owner.holds).toEqual([`${BOT} take remote:viewer`])
    // Down to Use: the hold ends as if its lease ran out.
    access.level = 'use'
    for (const listener of listeners) listener()
    await vi.waitFor(() => expect(owner.ended).toEqual([`${BOT} remote:viewer`]))
  })
})

describe('a device the bot’s computer lets go of', () => {
  it('says the hold ended on the view before the view ends, when the device loses its reach', async () => {
    const { host, viewer, window, shown, ownerNode, viewerNode, lose } = setup({ level: 'full' })
    await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5, viewId: 'v1' })
    await host.hold(viewerNode, BOT, 'v1', { op: 'take' })
    lose({ reach: false })
    await vi.waitFor(() => expect(shown.at(-1)).toMatchObject({ stalled: 'forbidden' }))
    expect(shown.map((event) => event.holdEnded ?? event.stalled)).toEqual(['expired', 'forbidden'])
    // The browser is the bot's again, as the window shows it.
    expect(shown[0]).toMatchObject({ holdEnded: 'expired', control: 'bot', holder: 'bot' })
  })

  it('ends its views and every hold it has when it no longer reaches this computer, one opened without a view too', async () => {
    const { host, viewer, owner, window, shown, ownerNode, viewerNode } = setup({ level: 'full' })
    await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5 })
    // An older window's open names no view: the browser is still that device's.
    await host.open(viewerNode, BOT, {})
    host.releaseNode(viewerNode)
    await vi.waitFor(() => expect(owner.ended).toEqual([`${BOT} remote:${viewerNode}`]))
    await vi.waitFor(() => expect(shown.at(-1)).toMatchObject({ stalled: 'forbidden' }))
    expect([viewer.viewCount, host.viewCount]).toEqual([0, 0])
  })

  it('ends a hold opened without a view when Full goes', async () => {
    const { host, owner, viewerNode, lose } = setup({ level: 'full' })
    await host.open(viewerNode, BOT, { url: 'https://example.com/' })
    lose({ level: 'use' })
    await vi.waitFor(() => expect(owner.ended).toEqual([`${BOT} remote:${viewerNode}`]))
  })

  it('keeps the hold when a view’s stream alone ends with its computer still there, and the view goes on', async () => {
    const { link, host, viewer, owner, window, shown, ownerNode, viewerNode, streams } = setup({ level: 'full' })
    // As `WatchedBrowser` answers: a hold is bound to the device's connection and its view; a view's watch (under its
    // stream's own connection) sees that view hold it, and the hold itself is told only to the hold's connection.
    const hold = { id: 'hold_1', lastSeq: 0, computer: 'Owner' }
    let held: { viewId: string; connectionId: string } | undefined
    const watch = owner.port.watch
    owner.port.watch = async (botId, watchId, input) => {
      await watch(botId, watchId, input)
      return held && input.viewId === held.viewId ? { ...VIEW, control: 'remote', holder: 'this-view' } as BotBrowserView : VIEW
    }
    owner.port.view = async (_botId, input) =>
      held && input?.viewId === held.viewId ? { ...VIEW, control: 'remote', holder: 'this-view', ...(input.connectionId === held.connectionId ? { hold } : {}) } as BotBrowserView : VIEW
    const hold_ = owner.port.hold
    owner.port.hold = async (botId, viewId, request, connectionId) => {
      held = { viewId, connectionId }
      return hold_(botId, viewId, request, connectionId)
    }
    await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5, viewId: 'v1' })
    await host.hold(viewerNode, BOT, 'v1', { op: 'take' })

    // Its path switched: the old stream is reset with the computer still there. Then a reset of the stream alone.
    for (const [round, reason] of [[1, 'path_replaced'], [2, 'too_large']] as const) {
      streams[round - 1]!.reset(reason)
      await vi.waitFor(() => expect(owner.watches).toHaveLength(round + 1))
      await vi.waitFor(() => expect([viewer.viewCount, host.viewCount]).toEqual([1, 1]))
      expect(link.outbound.isOpen()).toBe(true)
    }
    // The window is told nothing stopped, the hold goes on there, and pictures come on the new stream.
    expect(shown.filter((event) => event.stalled || event.holdEnded)).toEqual([])
    expect(owner.ended).toEqual([])
    await owner.watches.at(-1)!.emit(picture(7))
    await vi.waitFor(() => expect(shown.at(-1)?.frame?.at).toBe(7))
    // The window's next renewal, on the new stream, gets its hold back.
    const renewed = await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5, viewId: 'v1' })
    expect(renewed.browser).toMatchObject({ holder: 'this-view', hold: { id: 'hold_1' } })
  })

  it('says its computer is offline, so the window drops its hold, only when it is', async () => {
    const { link, viewer, window, shown, ownerNode, viewerNode, host } = setup({ level: 'full' })
    await viewer.watch(window, ownerNode, BOT, { watchId: 'w1', width: 480, fps: 5, viewId: 'v1' })
    await host.hold(viewerNode, BOT, 'v1', { op: 'take' })
    link.cut()
    await vi.waitFor(() => expect(shown.at(-1)).toMatchObject({ watchId: 'w1', stalled: 'offline' }))
    expect(viewer.viewCount).toBe(0)
  })

  it('says to update the other computer when its pairing has no view streams', async () => {
    const viewer = new RemoteBotViews({
      open: () => { throw new NetError('incompatible_peer') },
      online: () => true,
      computer: (node) => ({ node, name: 'Studio' })
    })
    await expect(viewer.watch({ id: 'window-1', emit: () => undefined }, 'n_studio' as NodeId, BOT, { watchId: 'w1', width: 480, fps: 5 }))
      .rejects.toMatchObject({ code: 'incompatible_peer', message: "Update Mousse on Studio to watch its bots' browsers." })
  })
})

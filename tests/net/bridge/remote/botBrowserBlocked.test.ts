/**
 * A blocked device and a bot's browser (`docs/plans/remote-bots.md`, live view), through the profile's real Bridge and
 * its device policy: blocked is Off for the browser as for every bot stream, whatever bot level the device had. Its
 * view ends, its hold ends, and it can't watch again, as soon as the block is saved.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { MmsProfileServices } from '../../../../src/mms/MmsProfileServices'
import { MousseConfigStore } from '../../../../src/mms/config/MousseConfigStore'
import { ProviderAuthService } from '../../../../src/mms/providers/ProviderAuthService'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import { NetService } from '../../../../src/mms/net/NetService'
import { BridgeProfileService } from '../../../../src/mms/bridge/BridgeProfileService'
import { RemoteBotViews } from '../../../../src/mms/bridge/routed/remoteBotViews'
import { newId, type NodeId } from '../../../../src/shared/net'
import type { BotBrowserFrameEvent, BotBrowserView } from '../../../../src/shared/bots/personal/browser'
import { fakeLink } from '../../../netEngine/fakeLink'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => { try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the temp folder */ } })
  return path
}

const VIEW = { open: true, control: 'bot', holder: 'bot', activations: [] } as unknown as BotBrowserView

it('ends a blocked device’s view and hold as the block is saved, and refuses its next watch', async () => {
  const home = directory('bot-browser-blocked-')
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId: randomUUID(), allowLegacyProjectData: false }
  )
  cleanup.push(() => services.stop())
  // The profile's bots, with one bot, and its browsers without a real browser: what they are asked is what is checked.
  const bot = { id: 'bot-0123456789ab', name: 'Browser keeper' }
  const service = {
    list: () => ({ bots: [bot] }),
    get: (botId: string) => {
      if (botId !== bot.id) throw Object.assign(new Error('No such bot.'), { code: 'bot_not_found' })
      return { summary: bot, permissions: [], runs: [] }
    },
    withdrawQueued: async () => 0
  }
  Object.defineProperty(services, 'personalBots', { value: { service, liveActivity: () => undefined, events: new EventEmitter() }, configurable: true })
  const asked: string[] = []
  vi.spyOn(services.botBrowsers, 'watch').mockImplementation(async (_botId, _watchId, input) => {
    asked.push(`watch ${input.connectionId}`)
    return VIEW
  })
  vi.spyOn(services.botBrowsers, 'unwatch').mockImplementation(() => void asked.push('unwatch'))
  vi.spyOn(services.botBrowsers, 'hold').mockImplementation(async (_botId, _viewId, request, connectionId) => {
    asked.push(`hold ${request.op} ${connectionId}`)
    return { browser: VIEW, hold: { id: 'hold_1', lastSeq: 0, computer: 'Desk' } }
  })
  vi.spyOn(services.botBrowsers, 'endHoldsOf').mockImplementation(async (_botId, connectionId) => void asked.push(`endHoldsOf ${connectionId}`))

  let bridge: BridgeProfileService | undefined
  const net = new NetService({
    profileDir: home,
    composeRuntime: (runtime) => (bridge = new BridgeProfileService({ services, runtime, net })).composition()
  })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { name: 'desk', listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'bot-browser-blocked' })
  const self = net.runtime().identity.self()!
  const phone = new NetService({ profileDir: directory('bot-browser-blocked-phone-') })
  cleanup.push(() => phone.shutdown())
  const invite = net.runtime().enrollment.issueNodeInvite({ name: 'pocket', kind: 'phone' }).text
  const joined = (await phone.request('bridge.join', { invite, name: 'pocket' })) as { node: NodeId }
  await vi.waitFor(() => expect(net.status().peers).toContainEqual({ node: joined.node, state: 'open' }), { timeout: 15_000 })
  await vi.waitFor(() => expect(phone.status().peers).toContainEqual({ node: self.node, state: 'open' }), { timeout: 15_000 })
  services.botDeviceAccess.set(bot.id, { mode: 'chosen', nodes: [joined.node] })
  await net.request('bridge.policy', { node: joined.node, bots: 'full' })

  // The phone watches the bot's browser (its view's stream, handed to the Bridge as the engine does) and takes it over.
  const link = fakeLink({ ownerOnCaller: self.node, callerOnOwner: joined.node, grant: '1', endpoint: 'e' })
  link.inbound.onStream((stream) => bridge!.botViews.accept(joined.node, stream))
  const shown: BotBrowserFrameEvent[] = []
  const viewer = new RemoteBotViews({ open: () => link.outbound.open('mousse.botview'), online: () => true, computer: (node) => ({ node, name: 'Desk' }) })
  const window = { id: 'window-1', emit: (_type: string, data: unknown) => void shown.push(data as BotBrowserFrameEvent) }
  await viewer.watch(window, self.node, bot.id, { watchId: 'w1', width: 480, fps: 5 })
  await phone.session(self.node).rpc('bots.browser.hold', { botId: bot.id, viewId: 'v1', request: { op: 'take' } }, { id: newId('rpc'), deadlineMs: 10_000 })
  expect(asked).toEqual([`watch remote:${joined.node}:v1`, `hold take remote:${joined.node}`])
  expect(bridge!.botViews.viewCount).toBe(1)

  // Blocked: at once, with its bot level still Full on record.
  await net.request('bridge.policy', { node: joined.node, blocked: true })
  expect(bridge!.botViews.viewCount).toBe(0)
  await vi.waitFor(() => expect(asked).toContain(`endHoldsOf remote:${joined.node}`))
  await vi.waitFor(() => expect(shown.at(-1)).toMatchObject({ watchId: 'w1', stalled: 'forbidden' }))
  await expect(viewer.watch(window, self.node, bot.id, { watchId: 'w1', width: 480, fps: 5 })).rejects.toMatchObject({ code: 'forbidden' })
  expect(asked.filter((entry) => entry.startsWith('watch'))).toHaveLength(1)
}, 60_000)

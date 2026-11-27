/**
 * A new bot's choice of devices is saved before the bot is published (`BotChatService.create`). The claim here: a crash
 * between the two, then a restart, leaves no choice for a bot that was never made, and the retry of that create makes
 * the bot with its choice, once, unseen by a device it leaves out. Through the real profile, as the app opens it.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../../src/shared/net'
import type { BotDeviceAccess } from '../../src/shared/bots/personal/deviceAccess'
import { createBotReach } from '../../src/mms/bridge/remote/botReach'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'

const PHONE = newId('node')
const TABLET = newId('node')
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function profile(home: string, profileId: string): MmsProfileServices {
  const auth = new ProviderAuthService(join(home, 'provider-auth.json'))
  cleanup.push(() => auth.stop())
  const services = new MmsProfileServices(
    MousseConfigStore.load(home),
    { homeDir: home, repoRoot: home, headless: true, requireOwnership: false },
    null,
    home,
    { providerAuth: auth, domains: new DomainHandlerRegistry(), installationHome: home, profileId, allowLegacyProjectData: false }
  )
  cleanup.push(() => services.stop())
  return services
}

const saved = (services: MmsProfileServices) =>
  (JSON.parse(readFileSync(services.botDeviceAccess.path, 'utf8')) as { bots: Record<string, BotDeviceAccess> }).bots

describe('a crash after a new bot\'s choice is saved and before the bot is published', () => {
  it('leaves nothing after a restart, and the retry makes the bot once, still out of the phone\'s reach', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-reach-')))
    cleanup.push(() => rmSync(home, { recursive: true, force: true }))
    const profileId = randomUUID()
    const request = { look: { colour: 'teal', accessory: 'cap' }, name: 'Diary', description: 'Keep my diary', clientRequestId: 'desk-1', access: { mode: 'chosen', nodes: [TABLET] } as BotDeviceAccess }

    const first = profile(home, profileId)
    // The process dies between the two writes: the bot is never published, and nothing tidies up after it.
    vi.spyOn(first.personalBots!, 'createBot').mockImplementationOnce(() => { throw new Error('killed') })
    vi.spyOn(first.botDeviceAccess, 'forget').mockImplementationOnce(() => undefined)
    await expect(first.personalBots!.service.create(request)).rejects.toThrow('killed')
    const [orphan, ...rest] = Object.keys(saved(first))
    expect(orphan).toMatch(/^bot-/)
    expect(rest).toEqual([])
    expect(first.personalBots!.service.list().bots).toEqual([])
    await first.stop()

    const reopened = profile(home, profileId)
    expect(saved(reopened)).toEqual({})
    // The bot's first turn is not what is tested, and would start a model.
    vi.spyOn(reopened.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    const bots = reopened.personalBots!.service
    const made = (await bots.create(request)).bot
    expect(made.id).not.toBe(orphan)
    expect(made.reach).toBe('chosen')
    expect(saved(reopened)).toEqual({ [made.id]: { mode: 'chosen', nodes: [TABLET] } })
    // The same request again names the same bot and saves nothing more.
    expect((await bots.create({ ...request, access: { mode: 'all' } as never })).bot.id).toBe(made.id)
    expect(bots.list().bots.map((bot) => bot.id)).toEqual([made.id])
    expect(saved(reopened)).toEqual({ [made.id]: { mode: 'chosen', nodes: [TABLET] } })
    const store = reopened.botDeviceAccess
    const reach = createBotReach({
      access: (botId) => store.get(botId).access,
      choices: () => store.choices(),
      level: () => 'use',
      devices: () => [PHONE, TABLET],
      changes: [(listener) => store.onChange(listener)]
    })
    expect(reach.canReach(made.id, PHONE)).toBe(false)
    expect(reach.canReach(made.id, TABLET)).toBe(true)
    expect(reach.hiddenFor(PHONE)?.(made.id)).toBe(true)
  }, 60_000)
})

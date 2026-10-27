/**
 * PR 6 §6 unit 6d: a personal bot in a channel answers only the platform's confirmed owner, in a
 * direct message. The owner is confirmed only by "This is me" (a one-time code and the desktop
 * app's confirmation), never inferred from allowed users, pairing or the home chat. The audience is
 * checked on every message; everyone else is refused and nothing is activated.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelAuth } from '../../src/mms/channels/ChannelAuth'
import { BOT_NO_OWNER_REPLY, BOT_NOT_OWNER_REPLY, ChannelOwnerClaims, channelAudience, type ChannelBots } from '../../src/mms/channels/channelBots'
import { ChannelRouter } from '../../src/mms/channels/ChannelRouter'
import { ChannelSessionManager } from '../../src/mms/channels/ChannelSessionManager'
import { ChannelStore } from '../../src/mms/channels/ChannelStore'
import type { ChannelAdapter, InboundChannelMessage } from '../../src/mms/channels/types'
import { buildSessionKey } from '../../src/mms/channels/types'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import type { ChannelOwner, ChannelPlatformConfig } from '../../src/shared/types'

const T0 = Date.parse('2026-10-27T09:00:00.000Z')
const OWNER = 'u-owner'

let home: string
let originalHome: string | undefined
let clock: number
let store: ChannelStore
let sessions: ChannelSessionManager
let claims: ChannelOwnerClaims
let router: ChannelRouter
let sent: Array<{ chatId: string; text: string }>
let activated: Array<{ botId: string; input: string; clientRequestId: string }>
let turns: ReturnType<typeof vi.fn>

const bots: ChannelBots = {
  findByName: (name) => (name.toLowerCase() === 'site editor' || name === 'site-editor' ? { id: 'site-editor', name: 'Site editor' } : undefined),
  activateFromChannel: async (input) => { activated.push(input) },
  channelReply: () => undefined,
  recentChannelActivations: () => [],
  onChanged: () => () => {}
}

function configure(platform: Partial<ChannelPlatformConfig>): void {
  store.updateConfig({ platforms: { telegram: { enabled: true, ...platform }, discord: { enabled: false }, webhook: { enabled: false } } })
}

function setOwner(owner: ChannelOwner | undefined): void {
  const config = store.getConfig()
  const telegram = { ...config.platforms.telegram }
  if (owner) telegram.owner = owner
  else delete telegram.owner
  config.platforms.telegram = telegram
  store.saveConfig(config)
}

const dm = (userId: string, text: string, patch: Partial<InboundChannelMessage> = {}): InboundChannelMessage => ({
  platform: 'telegram', chatId: `chat-${userId}`, chatType: 'dm', userId, userName: userId, text, messageId: `m-${Math.random()}`, ...patch
})

/** Attaches the DM of `userId` to the bot directly in the session store (as an earlier `/bot` would). */
function attached(userId: string, patch: Record<string, unknown> = {}): void {
  const message = dm(userId, 'hello')
  const session = sessions.resolveThread(message)
  store.upsertSession({ ...session, botId: 'site-editor', ...patch })
}

beforeEach(() => {
  originalHome = process.env.MOUSSE_HOME
  home = mkdtempSync(join(tmpdir(), 'mousse-bot-channel-owner-'))
  process.env.MOUSSE_HOME = home
  clock = T0
  const config = MousseConfigStore.load()
  store = new ChannelStore(config)
  const projects = new ProjectManager()
  const threads = new ThreadDataStore(projects)
  projects.setThreadStore(threads)
  sessions = new ChannelSessionManager(store, threads)
  claims = new ChannelOwnerClaims(() => clock)
  sent = []
  activated = []
  turns = vi.fn(async () => ({ text: 'from-chat', silent: false }))
  const adapter: ChannelAdapter = {
    platform: 'telegram',
    connect: async () => {},
    disconnect: async () => {},
    getStatus: () => ({ platform: 'telegram', state: 'connected' }),
    setInboundHandler: () => {},
    send: async (message) => {
      sent.push({ chatId: message.chatId, text: message.text })
      return { success: true, messageId: '1' }
    }
  }
  router = new ChannelRouter(store, sessions, new ChannelAuth(store.getPairingDirectory()), { runChannelTurn: turns }, () => adapter, () => store.getConfig(), {
    settingsStore: new SettingsStore(config),
    threadStore: threads,
    listModels: () => [],
    bots,
    ownerClaims: claims
  })
  configure({ allowedUserIds: [OWNER, 'u-friend'] })
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

const owner: ChannelOwner = { userId: OWNER, displayName: 'Me', confirmedAt: new Date(T0).toISOString() }
const lastReply = () => sent.at(-1)?.text

describe('owner confirmation', () => {
  it('the owner is confirmed by a one-time code from their DM and the desktop confirmation', async () => {
    const { code } = claims.start('telegram')
    expect(code).toMatch(/^\d{6}$/)
    await router.handleInbound(dm(OWNER, `/owner ${code}`))
    expect(lastReply()).toBe('Code received. Confirm in Mousse that this is your account.')
    expect(claims.status('telegram')).toMatchObject({ attempted: true, claimant: { userId: OWNER, displayName: OWNER } })
    // Only the account that sent the code can be confirmed.
    expect(claims.confirm('telegram', 'u-friend')).toBeUndefined()
    const second = claims.start('telegram')
    await router.handleInbound(dm(OWNER, `/owner ${second.code}`))
    expect(claims.confirm('telegram', OWNER)).toEqual({ userId: OWNER, displayName: OWNER, confirmedAt: new Date(T0).toISOString() })
    // The claim ends with the confirmation.
    expect(claims.status('telegram')).toBeNull()
    expect(activated).toEqual([])
  })

  it('a code allows one attempt, only from a DM, and expires after 10 minutes', async () => {
    const { code } = claims.start('telegram')
    await router.handleInbound(dm(OWNER, `/owner ${code}`, { chatType: 'group', chatId: 'group-1' }))
    expect(lastReply()).toBe('Send /owner from a direct message to this bot.')
    await router.handleInbound(dm('u-friend', `/owner ${code === '000000' ? '111111' : '000000'}`))
    expect(lastReply()).toMatch(/not valid/)
    // The one attempt is used: the right code no longer works.
    await router.handleInbound(dm(OWNER, `/owner ${code}`))
    expect(lastReply()).toMatch(/not valid/)
    expect(claims.confirm('telegram', OWNER)).toBeUndefined()
    const late = claims.start('telegram')
    clock += 10 * 60_000
    await router.handleInbound(dm(OWNER, `/owner ${late.code}`))
    expect(lastReply()).toMatch(/not valid/)
  })

  it('the owner is never inferred: allowed users, pairing and the home chat give no owner', async () => {
    configure({ allowedUserIds: [OWNER], homeChatId: `chat-${OWNER}` })
    await router.handleInbound(dm(OWNER, '/bot site editor'))
    expect(lastReply()).toBe(BOT_NO_OWNER_REPLY)
    expect(sessions.getSession(buildSessionKey('telegram', `chat-${OWNER}`))?.botId).toBeUndefined()
  })
})

describe('bot audience', () => {
  it('the owner attaches a bot with /bot and their DMs activate it, once per chat message', async () => {
    setOwner(owner)
    await router.handleInbound(dm(OWNER, '/bot site editor'))
    expect(lastReply()).toMatch(/now go to the bot Site editor/)
    await router.handleInbound(dm(OWNER, 'Fix the footer', { messageId: 'm1' }))
    expect(activated).toEqual([{ botId: 'site-editor', input: 'Fix the footer', clientRequestId: `${buildSessionKey('telegram', `chat-${OWNER}`)}:m1`, replyTo: { platform: 'telegram', chatId: `chat-${OWNER}`, messageId: 'm1' } }])
    expect(turns).not.toHaveBeenCalled()
    await router.handleInbound(dm(OWNER, '/bot off'))
    await router.handleInbound(dm(OWNER, 'Just chat'))
    expect(turns).toHaveBeenCalledTimes(1)
    expect(activated).toHaveLength(1)
  })

  it('the sole allowed non-owner is refused, and cannot attach a bot', async () => {
    configure({ allowedUserIds: ['u-friend'] })
    attached('u-friend')
    await router.handleInbound(dm('u-friend', 'Fix the footer'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    setOwner(owner)
    await router.handleInbound(dm('u-friend', 'Fix the footer'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    await router.handleInbound(dm('u-friend', '/bot site editor'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    expect(activated).toEqual([])
    expect(turns).not.toHaveBeenCalled()
  })

  it('a user merged in by pairing is refused', async () => {
    setOwner(owner)
    configure({ allowedUserIds: [OWNER] })
    const auth = new ChannelAuth(store.getPairingDirectory())
    const request = auth.createPairingRequest(dm('u-paired', 'hi'))!
    expect(auth.approvePairing(request.code)).toBe(true)
    attached('u-paired')
    await router.handleInbound(dm('u-paired', 'Fix the footer'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    expect(activated).toEqual([])
  })

  it('the audience is checked again after an owner change', async () => {
    setOwner(owner)
    attached(OWNER)
    await router.handleInbound(dm(OWNER, 'one'))
    expect(activated).toHaveLength(1)
    setOwner({ ...owner, userId: 'u-other' })
    await router.handleInbound(dm(OWNER, 'two'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    setOwner(undefined)
    await router.handleInbound(dm(OWNER, 'three'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    expect(activated).toHaveLength(1)
  })

  it('a group and a stranger under allowAllUsers are refused', async () => {
    setOwner(owner)
    configure({ allowAllUsers: true })
    setOwner(owner)
    // The owner themself, in a group attached to the bot.
    const group = dm(OWNER, 'Fix the footer', { chatType: 'group', chatId: 'group-1' })
    store.upsertSession({ ...sessions.resolveThread(group), botId: 'site-editor' })
    await router.handleInbound(group)
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    attached('u-stranger')
    await router.handleInbound(dm('u-stranger', 'Fix the footer'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    expect(activated).toEqual([])
  })

  it('a session whose userId is undefined is refused', async () => {
    setOwner(owner)
    attached(OWNER, { userId: undefined })
    expect(sessions.getSession(buildSessionKey('telegram', `chat-${OWNER}`))?.userId).toBeUndefined()
    await router.handleInbound(dm(OWNER, 'Fix the footer'))
    expect(lastReply()).toBe(BOT_NOT_OWNER_REPLY)
    expect(activated).toEqual([])
  })

  it('channelAudience is owner only for the owner\'s own DM session', () => {
    const session = { sessionKey: 'k', platform: 'telegram' as const, chatId: 'c', chatType: 'dm' as const, userId: OWNER, mousseThreadId: 't', createdAt: 'x' }
    const message = dm(OWNER, 'x')
    expect(channelAudience({ enabled: true, owner }, session, message)).toBe('owner')
    expect(channelAudience({ enabled: true }, session, message)).toBe('others')
    expect(channelAudience({ enabled: true, owner }, undefined, message)).toBe('others')
    expect(channelAudience({ enabled: true, owner }, session, { ...message, userId: 'u-friend' })).toBe('others')
    expect(channelAudience({ enabled: true, owner }, { ...session, platform: 'webhook' }, { ...message, platform: 'webhook' })).toBe('others')
  })
})

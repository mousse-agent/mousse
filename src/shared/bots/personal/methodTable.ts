import type { NodeCapability } from '../../net/capabilities'
import type { AccessClass } from '../../net/accessClasses'
import { BOTS_PERSONAL_V2_CAPABILITY, type BotsPersonalV2Method } from './methods'
import type { BotDeviceMethod } from './deviceAccess'
import {
  BOTS_BROWSER_HOLD_CAPABILITY,
  BOTS_BROWSER_STREAM_CAPABILITY,
  BOTS_BROWSER_WINDOW_CAPABILITY,
  type BOT_BROWSER_FILES_METHOD,
  type BOT_BROWSER_WINDOW_METHOD,
  type BotsBrowserMethod
} from './browser'

/**
 * Who on this computer may call a local method, when not every client of the profile may: `window`, only the app's own
 * window (`clientType` gui); `this_computer`, its window or its command line. A call that came through Bridge (another
 * computer's routed call) is refused either way, with `forbidden` and `refusal`'s words.
 */
export interface BotMethodCallers {
  callers: 'window' | 'this_computer'
  refusal: string
}

/** How this computer's own clients call a bot method (the daemon's `bots.*` handlers). */
export interface BotMethodLocal {
  /**
   * The registration that serves it: `chat`, `registerPersonalBotMethods` (the profile's `BotChatService`); `devices`,
   * `registerBotDeviceMethods` (About → Devices); `browser`, `registerBotBrowserMethods` (the bot's browser).
   */
  by: 'chat' | 'devices' | 'browser'
  /** The exact keys it takes, besides `profileId`. Any other key is `invalid_params`. */
  keys: readonly string[]
  /** The protocol capability it is offered under. */
  capability: string
  /** Absent: any client of the profile. */
  only?: BotMethodCallers
}

/**
 * How the user's other devices (phones and other computers) call a bot method here (`remoteBotMethods`). A method
 * without it is never offered to another device.
 */
export interface BotMethodRemote {
  /** Its class in `METHOD_ACCESS`, which the device's switches on this computer are checked against. */
  access: Extract<AccessClass, 'bots_chat' | 'bots_manage'>
  /** The Net capability the call needs. */
  capability: NodeCapability
  /** A change: its result is kept in the request ledger, and a retry gets it back. A read is never kept. */
  mutating: boolean
  /** The keys it must have, and those it may have; any other is `bad_request`. */
  required: readonly string[]
  optional?: readonly string[]
  /** The version `net.info` reports for it (`bots`), when above 1, so a device sends only keys this computer knows. */
  version?: number
}

export interface BotMethodRow {
  local?: BotMethodLocal
  remote?: BotMethodRemote
}

type LocalBy<By extends BotMethodLocal['by']> = BotMethodLocal & { by: By }
const chat = (keys: readonly string[], only?: BotMethodCallers): LocalBy<'chat'> => ({ by: 'chat', keys, capability: BOTS_PERSONAL_V2_CAPABILITY, ...(only ? { only } : {}) })
const browser = (keys: readonly string[], capability: string = BOTS_PERSONAL_V2_CAPABILITY): LocalBy<'browser'> => ({ by: 'browser', keys, capability })
const THIS_COMPUTER: BotMethodCallers = { callers: 'this_computer', refusal: 'Change which devices reach a bot on its own computer.' }
const devices = (keys: readonly string[]): LocalBy<'devices'> => ({ by: 'devices', keys, capability: BOTS_PERSONAL_V2_CAPABILITY, only: THIS_COMPUTER })
const reads = (required: readonly string[], optional?: readonly string[]): BotMethodRemote => ({ access: 'bots_chat', capability: 'read', mutating: false, required, ...(optional ? { optional } : {}) })
const chats = (access: BotMethodRemote['access'], required: readonly string[], optional?: readonly string[]): BotMethodRemote => ({ access, capability: 'chat', mutating: true, required, ...(optional ? { optional } : {}) })
const writes = (required: readonly string[], optional?: readonly string[], version?: number): BotMethodRemote => ({ access: 'bots_manage', capability: 'write', mutating: true, required, ...(optional ? { optional } : {}), ...(version ? { version } : {}) })

/**
 * Every personal-bot method, local and remote, in one place: what this computer's clients send (`local`), and whether
 * and how the user's other devices may call it (`remote`). The daemon's registrations, `remoteBotMethods` and the bot
 * rows of `METHOD_ACCESS` are all made from it, so a method is added here once. Each row's handler stays with its
 * registration in the daemon, keyed by the row's name.
 *
 * The remote keys differ from the local ones where a device has no use for them: no `attachments` on a message (they
 * name files on this computer), a new bot's `reach` instead of `access`, and no prompt edit in `bots.update`.
 */
export const BOT_METHODS = {
  // ---------------------------------------------------------------- the Bot UI (`bots.personal.v2`)
  'bots.personal.list': { local: chat([]) },
  'bots.create': {
    local: chat(['look', 'name', 'description', 'clientRequestId', 'model', 'slots', 'image', 'access']),
    // 2: `reach` (`RemoteBotReach`).
    remote: writes(['look', 'description', 'clientRequestId'], ['name', 'reach'], 2)
  },
  'bots.get': { local: chat(['botId']), remote: reads(['botId']) },
  'bots.update': { local: chat(['botId', 'name', 'look', 'description']), remote: writes(['botId'], ['name', 'look']) },
  'bots.personal.pause': { local: chat(['botId']), remote: writes(['botId']) },
  'bots.personal.resume': { local: chat(['botId']), remote: writes(['botId']) },
  'bots.delete': { local: chat(['botId']) },
  'bots.chat.list': { local: chat(['botId', 'beforeSeq', 'limit']), remote: reads(['botId'], ['beforeSeq', 'limit']) },
  'bots.chat.send': {
    local: chat(['botId', 'text', 'attachments', 'clientRequestId', 'replyTo']),
    remote: chats('bots_chat', ['botId', 'text', 'clientRequestId'], ['replyTo'])
  },
  'bots.chat.stop': { local: chat(['botId']), remote: chats('bots_chat', ['botId']) },
  'bots.chat.markRead': { local: chat(['botId', 'seq']), remote: chats('bots_chat', ['botId', 'seq']) },
  // Both choices on a permission ask or held external action require Work; reading the cards stays bots_chat.
  'bots.asks.answer': { local: chat(['botId', 'askId', 'answer']), remote: chats('bots_manage', ['botId', 'askId', 'answer']) },
  'bots.permissions.set': {
    local: chat(['botId', 'permissionId', 'enabled'], { callers: 'window', refusal: 'Change permissions in the app window.' }),
    remote: writes(['botId', 'permissionId', 'enabled'])
  },
  'bots.permissions.revoke': { local: chat(['botId', 'permissionId']), remote: writes(['botId', 'permissionId']) },
  'bots.schedules.add': { local: chat(['botId', 'when', 'prompt', 'model']) },
  'bots.schedules.remove': { local: chat(['botId', 'scheduleId']), remote: writes(['botId', 'scheduleId']) },
  'bots.model.get': { local: chat(['botId']) },
  'bots.model.set': { local: chat(['botId', 'model']) },
  'bots.memory.list': { local: chat(['botId', 'history']), remote: reads(['botId']) },
  'bots.memory.forget': { local: chat(['botId', 'id']), remote: writes(['botId', 'id']) },
  'bots.memory.export': { local: chat(['botId', 'dir']) },

  // ---------------------------------------------------------------- added after the Bot UI set (`BOTS_WORK_METHODS`)
  'bots.reminders.snooze': { local: chat(['botId', 'messageId', 'choice']), remote: chats('bots_chat', ['botId', 'messageId', 'choice']) },
  'bots.work.stop': { local: chat(['botId', 'workId']), remote: chats('bots_chat', ['botId', 'workId']) },
  'bots.reminders.cancel': { local: chat(['botId', 'reminderId']), remote: writes(['botId', 'reminderId']) },
  'bots.model.choices': { local: chat([]) },
  'bots.model.setSlots': { local: chat(['botId', 'slots', 'oneWork']) },
  'bots.model.setImage': { local: chat(['botId', 'pick']) },
  'bots.chat.react': { local: chat(['botId', 'messageId', 'emoji']) },
  'bots.questions.answer': {
    local: chat(['botId', 'questionId', 'choice', 'clientRequestId']),
    remote: chats('bots_chat', ['botId', 'questionId', 'choice', 'clientRequestId'])
  },
  'bots.memory.edit': { local: chat(['botId', 'id', 'text']), remote: writes(['botId', 'id', 'text']) },
  'bots.actions.answer': {
    local: chat(['botId', 'actionId', 'digest', 'answer']),
    remote: chats('bots_manage', ['botId', 'actionId', 'digest', 'answer'])
  },
  'bots.chat.clear': { local: chat(['botId']) },
  'bots.memory.wipe': { local: chat(['botId', 'keep']) },
  'bots.reset': { local: chat(['botId']) },
  'bots.model.setCustom': { local: chat(['botId', 'name', 'pick', 'description']) },
  // Only the owner lets bots go on messaging each other (issue #1443): a person at a window on this computer.
  'bots.chainHold.answer': {
    local: chat(['botId', 'holdId', 'answer'], { callers: 'window', refusal: 'Answer this in the Mousse window on the computer that runs the bot.' })
  },
  // The face picture is the app window's drawing of the bot's look: no agent, CLI or other device writes it.
  'bots.facePicture.save': { local: chat(['botId', 'key', 'png'], { callers: 'window', refusal: "Only the Mousse window saves a bot's face picture." }) },

  // ---------------------------------------------------------------- another device only
  // A picture from a bot's chat, in parts; this computer's app reads the file itself.
  'bots.chat.attachment': { remote: reads(['botId', 'messageId', 'index'], ['offset']) },

  // ---------------------------------------------------------------- About → Devices (`BOT_DEVICE_METHODS`)
  'bots.devices.get': { local: devices(['botId']) },
  'bots.devices.set': { local: devices(['botId', 'access']) },

  // ---------------------------------------------------------------- the bot's browser (`BOTS_BROWSER_METHODS`)
  // Taking over, input, a fresh picture, opening and closing are the desktop app's on this computer alone; each handler
  // checks its connection, as some depend on the params (`get` with `frame`).
  'bots.browser.get': { local: browser(['botId', 'frame', 'viewId']) },
  'bots.browser.control': { local: browser(['botId', 'control']) },
  'bots.browser.input': { local: browser(['botId', 'input']) },
  'bots.browser.open': { local: browser(['botId', 'url', 'viewId', 'platform']) },
  'bots.browser.close': { local: browser(['botId']) },
  'bots.browser.watch': { local: browser(['botId', 'watchId', 'width', 'fps', 'viewId', 'page'], BOTS_BROWSER_STREAM_CAPABILITY) },
  'bots.browser.unwatch': { local: browser(['botId', 'watchId'], BOTS_BROWSER_STREAM_CAPABILITY) },
  'bots.browser.hold': { local: browser(['botId', 'viewId', 'request'], BOTS_BROWSER_HOLD_CAPABILITY) },
  'bots.browser.send': { local: browser(['botId', 'viewId', 'holdId', 'inputs'], BOTS_BROWSER_HOLD_CAPABILITY) },
  // The app's main process's alone: the renderer's request bridge does not offer them.
  'bots.browser.window': { local: browser(['botId', 'viewId', 'holdId', 'op', 'display'], BOTS_BROWSER_WINDOW_CAPABILITY) },
  'bots.browser.files': { local: browser(['botId', 'viewId', 'holdId', 'paths'], BOTS_BROWSER_HOLD_CAPABILITY) }
} as const satisfies Record<string, BotMethodRow>

type Rows = typeof BOT_METHODS
export type BotMethod = keyof Rows
/** The methods another device may call here. */
export type RemoteBotMethod = { [M in BotMethod]: Rows[M] extends { remote: BotMethodRemote } ? M : never }[BotMethod]
/** The methods one local registration serves. */
export type LocalBotMethod<By extends BotMethodLocal['by']> = { [M in BotMethod]: Rows[M] extends { local: { by: By } } ? M : never }[BotMethod]

/** Each registration's rows are exactly the methods its published list names; a row missing or extra fails to compile. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const LISTS_MATCH: [
  Same<LocalBotMethod<'chat'>, BotsPersonalV2Method>,
  Same<LocalBotMethod<'devices'>, BotDeviceMethod>,
  Same<LocalBotMethod<'browser'>, BotsBrowserMethod | typeof BOT_BROWSER_WINDOW_METHOD | typeof BOT_BROWSER_FILES_METHOD>
] = [true, true, true]
void LISTS_MATCH

const NAMES = Object.keys(BOT_METHODS) as BotMethod[]
const row = (name: BotMethod): BotMethodRow => BOT_METHODS[name]

/** The methods `by` registers locally, in the table's order. */
export function localBotMethods<By extends BotMethodLocal['by']>(by: By): LocalBotMethod<By>[] {
  return NAMES.filter((name) => row(name).local?.by === by) as LocalBotMethod<By>[]
}

/** How this computer's clients call `name`. */
export function localBotMethod(name: BotMethod): BotMethodLocal {
  const local = row(name).local
  if (!local) throw new Error(`${name} is not a local bot method`)
  return local
}

/** The methods another device may call here, in the table's order. */
export const REMOTE_BOT_METHOD_NAMES: readonly RemoteBotMethod[] = NAMES.filter((name) => row(name).remote) as RemoteBotMethod[]

/** How another device calls `name`. */
export function remoteBotMethod(name: RemoteBotMethod): BotMethodRemote {
  return row(name).remote!
}

/** The bot rows of `METHOD_ACCESS`: each method another device may call, with its class. */
export function botMethodAccess(): Record<RemoteBotMethod, AccessClass> {
  return Object.fromEntries(REMOTE_BOT_METHOD_NAMES.map((name) => [name, remoteBotMethod(name).access])) as Record<RemoteBotMethod, AccessClass>
}

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

/**
 * What a bot method needs of the device that calls it (`docs/bots.md`, Bot access per device): `use`, a device at Use
 * or Full; `full`, a device at Full; `local`, this computer's own clients only, whatever any device's level (a path on
 * this computer, or a handle only its main process holds). Another device calls only the rows with `remote`, and only
 * at the level the row names, checked in `remoteBotMethods`' one wrapper.
 */
export type BotMethodLevel = 'use' | 'full' | 'local'

export type BotMethodRow =
  | { level: 'use' | 'full'; local?: BotMethodLocal; remote?: BotMethodRemote }
  /** A `local` row is never offered to another device. */
  | { level: 'local'; local: BotMethodLocal; remote?: never }

type LocalBy<By extends BotMethodLocal['by']> = BotMethodLocal & { by: By }
const chat = (keys: readonly string[], only?: BotMethodCallers): LocalBy<'chat'> => ({ by: 'chat', keys, capability: BOTS_PERSONAL_V2_CAPABILITY, ...(only ? { only } : {}) })
const browser = (keys: readonly string[], capability: string = BOTS_PERSONAL_V2_CAPABILITY): LocalBy<'browser'> => ({ by: 'browser', keys, capability })
const THIS_COMPUTER: BotMethodCallers = { callers: 'this_computer', refusal: 'Change which devices reach a bot on its own computer.' }
const devices = (keys: readonly string[]): LocalBy<'devices'> => ({ by: 'devices', keys, capability: BOTS_PERSONAL_V2_CAPABILITY, only: THIS_COMPUTER })
const reads = (required: readonly string[], optional?: readonly string[]): BotMethodRemote => ({ capability: 'read', mutating: false, required, ...(optional ? { optional } : {}) })
const chats = (required: readonly string[], optional?: readonly string[]): BotMethodRemote => ({ capability: 'chat', mutating: true, required, ...(optional ? { optional } : {}) })
const writes = (required: readonly string[], optional?: readonly string[], version?: number): BotMethodRemote => ({ capability: 'write', mutating: true, required, ...(optional ? { optional } : {}), ...(version ? { version } : {}) })

/**
 * Every personal-bot method, local and remote, in one place: the level a device needs for it (`level`), what this
 * computer's clients send (`local`), and whether and how the user's other devices may call it (`remote`). The daemon's
 * registrations, `remoteBotMethods` (and its one gate) and the bot rows of `METHOD_ACCESS` are all made from it, so a
 * method is added here once. Each row's handler stays with its registration in the daemon, keyed by the row's name.
 *
 * Use is for using a bot as it is set up: chat, answers to its questions and held actions (within its permissions),
 * Stop, reading its chat, memory and browser. Full is everything else another device may do: setting it up, granting
 * permissions (answering an ask is a grant), memory edits, delete, taking over its browser, its Devices, new bots.
 * A row with a level but no `remote` is not offered to another device yet; its level is the one it gets when it is.
 *
 * The remote keys differ from the local ones where a device has no use for them: `staged` files instead of a message's
 * `attachments` (which name files on this computer), and no single `model` by name on a new bot (an app from before
 * rows). A new bot's `access` from another device always keeps that device, as does `bots.devices.set`.
 */
export const BOT_METHODS = {
  // ---------------------------------------------------------------- the Bot UI (`bots.personal.v2`)
  'bots.personal.list': { level: 'use', local: chat([]) },
  'bots.create': {
    level: 'full',
    local: chat(['look', 'name', 'description', 'clientRequestId', 'model', 'slots', 'image', 'access']),
    // 2: `reach` (`RemoteBotReach`). 3: the rows, the Images row and the Devices step of New bot "Lives on" (`slots`,
    // `image`, `access`), each as the bot's computer offers them.
    remote: writes(['look', 'description', 'clientRequestId'], ['name', 'reach', 'slots', 'image', 'access'], 3)
  },
  'bots.get': { level: 'use', local: chat(['botId']), remote: reads(['botId']) },
  // 2: `description`, the bot's instructions as About edits them.
  'bots.update': { level: 'full', local: chat(['botId', 'name', 'look', 'description']), remote: writes(['botId'], ['name', 'look', 'description'], 2) },
  'bots.personal.pause': { level: 'full', local: chat(['botId']), remote: writes(['botId']) },
  'bots.personal.resume': { level: 'full', local: chat(['botId']), remote: writes(['botId']) },
  'bots.delete': { level: 'full', local: chat(['botId']), remote: writes(['botId']) },
  'bots.chat.list': { level: 'use', local: chat(['botId', 'beforeSeq', 'limit']), remote: reads(['botId'], ['beforeSeq', 'limit']) },
  'bots.chat.send': {
    level: 'use',
    local: chat(['botId', 'text', 'attachments', 'clientRequestId', 'replyTo']),
    // `staged`: files another device sent ahead with `bots.stage`, for this bot and from that device alone.
    remote: chats(['botId', 'text', 'clientRequestId'], ['replyTo', 'staged'])
  },
  'bots.chat.stop': { level: 'use', local: chat(['botId']), remote: chats(['botId']) },
  'bots.chat.markRead': { level: 'use', local: chat(['botId', 'seq']), remote: chats(['botId', 'seq']) },
  // Allow on a permission ask is a grant, and Not now answers the same card.
  'bots.asks.answer': { level: 'full', local: chat(['botId', 'askId', 'answer']), remote: chats(['botId', 'askId', 'answer']) },
  'bots.permissions.set': {
    level: 'full',
    local: chat(['botId', 'permissionId', 'enabled'], { callers: 'window', refusal: 'Change permissions in the app window.' }),
    remote: writes(['botId', 'permissionId', 'enabled'])
  },
  'bots.permissions.revoke': { level: 'full', local: chat(['botId', 'permissionId']), remote: writes(['botId', 'permissionId']) },
  'bots.schedules.add': { level: 'full', local: chat(['botId', 'when', 'prompt', 'model']) },
  'bots.schedules.remove': { level: 'full', local: chat(['botId', 'scheduleId']), remote: writes(['botId', 'scheduleId']) },
  // Runs on: the bot's models and the entries they are on, as the bot's computer has them.
  'bots.model.get': { level: 'full', local: chat(['botId']), remote: reads(['botId']) },
  'bots.model.set': { level: 'full', local: chat(['botId', 'model']) },
  'bots.memory.list': { level: 'use', local: chat(['botId', 'history']), remote: reads(['botId']) },
  'bots.memory.forget': { level: 'full', local: chat(['botId', 'id']), remote: writes(['botId', 'id']) },
  // Writes into a folder on this computer.
  'bots.memory.export': { level: 'local', local: chat(['botId', 'dir']) },

  // ---------------------------------------------------------------- added after the Bot UI set (`BOTS_WORK_METHODS`)
  'bots.reminders.snooze': { level: 'use', local: chat(['botId', 'messageId', 'choice']), remote: chats(['botId', 'messageId', 'choice']) },
  'bots.work.stop': { level: 'use', local: chat(['botId', 'workId']), remote: chats(['botId', 'workId']) },
  'bots.reminders.cancel': { level: 'full', local: chat(['botId', 'reminderId']), remote: writes(['botId', 'reminderId']) },
  // New bot's choices on the computer it will live on: its models, and its devices for the Devices step.
  'bots.model.choices': { level: 'full', local: chat([]), remote: reads([]) },
  'bots.model.setSlots': { level: 'full', local: chat(['botId', 'slots', 'oneWork']), remote: writes(['botId'], ['slots', 'oneWork']) },
  'bots.model.setImage': { level: 'full', local: chat(['botId', 'pick']), remote: writes(['botId', 'pick']) },
  'bots.chat.react': { level: 'use', local: chat(['botId', 'messageId', 'emoji']) },
  'bots.questions.answer': {
    level: 'use',
    local: chat(['botId', 'questionId', 'choice', 'clientRequestId']),
    remote: chats(['botId', 'questionId', 'choice', 'clientRequestId'])
  },
  'bots.memory.edit': { level: 'full', local: chat(['botId', 'id', 'text']), remote: writes(['botId', 'id', 'text']) },
  // A held action runs within the permissions the bot already has: sending it grants nothing.
  'bots.actions.answer': {
    level: 'use',
    local: chat(['botId', 'actionId', 'digest', 'answer']),
    remote: chats(['botId', 'actionId', 'digest', 'answer'])
  },
  'bots.chat.clear': { level: 'full', local: chat(['botId']) },
  'bots.memory.wipe': { level: 'full', local: chat(['botId', 'keep']) },
  'bots.reset': { level: 'full', local: chat(['botId']) },
  'bots.model.setCustom': { level: 'full', local: chat(['botId', 'name', 'pick', 'description']) },
  // Only the owner lets bots go on messaging each other (issue #1443): a person at a window on this computer.
  'bots.chainHold.answer': {
    level: 'local',
    local: chat(['botId', 'holdId', 'answer'], { callers: 'window', refusal: 'Answer this in the Mousse window on the computer that runs the bot.' })
  },
  // The face picture is the app window's drawing of the bot's look: no agent, CLI or other device writes it.
  'bots.facePicture.save': { level: 'local', local: chat(['botId', 'key', 'png'], { callers: 'window', refusal: "Only the Mousse window saves a bot's face picture." }) },

  // ---------------------------------------------------------------- another device only
  // A picture from a bot's chat, in parts; this computer's app reads the file itself.
  // It stays until the phone app moves to `bots.chat.file` (#2023).
  'bots.chat.attachment': { level: 'use', remote: reads(['botId', 'messageId', 'index'], ['offset']) },
  // A file of the bot's files folder, in pages (never SVG); this computer's app reads the file itself.
  'bots.chat.file': { level: 'use', remote: reads(['botId', 'path'], ['offset']) },
  // A file for a message to the bot, sent ahead in parts: the first names it (`name`, `size`), the rest its `stage`.
  'bots.stage': { level: 'use', remote: chats(['botId', 'clientRequestId', 'offset', 'dataB64'], ['name', 'size', 'stage']) },
  // An applet a message of the bot shows (`messageId`), named by its id and revision: its source and its saved state, in
  // pages, and its state saved back here, which owns it. This computer's app runs its bots' applets from their threads.
  'bots.applets.get': { level: 'use', remote: reads(['botId', 'messageId', 'appletId', 'revisionId'], ['offset']) },
  'bots.applets.state.get': { level: 'use', remote: reads(['botId', 'messageId', 'appletId', 'revisionId'], ['offset']) },
  'bots.applets.state.save': { level: 'use', remote: chats(['botId', 'messageId', 'appletId', 'revisionId', 'state']) },

  // ---------------------------------------------------------------- About → Devices (`BOT_DEVICE_METHODS`)
  // From another device the list always keeps that device: it never shuts itself out of a bot it sets up.
  'bots.devices.get': { level: 'full', local: devices(['botId']), remote: reads(['botId']) },
  'bots.devices.set': { level: 'full', local: devices(['botId', 'access']), remote: writes(['botId', 'access']) },

  // ---------------------------------------------------------------- the bot's browser (`BOTS_BROWSER_METHODS`)
  // Taking over, input, a fresh picture, opening and closing are the desktop app's on this computer alone; each handler
  // checks its connection, as some depend on the params (`get` with `frame`). Watching is Use; taking over is Full.
  'bots.browser.get': { level: 'use', local: browser(['botId', 'frame', 'viewId']) },
  'bots.browser.control': { level: 'full', local: browser(['botId', 'control']) },
  'bots.browser.input': { level: 'full', local: browser(['botId', 'input']) },
  'bots.browser.open': { level: 'full', local: browser(['botId', 'url', 'viewId', 'platform']) },
  'bots.browser.close': { level: 'full', local: browser(['botId']) },
  'bots.browser.watch': { level: 'use', local: browser(['botId', 'watchId', 'width', 'fps', 'viewId', 'page'], BOTS_BROWSER_STREAM_CAPABILITY) },
  'bots.browser.unwatch': { level: 'use', local: browser(['botId', 'watchId'], BOTS_BROWSER_STREAM_CAPABILITY) },
  'bots.browser.hold': { level: 'full', local: browser(['botId', 'viewId', 'request'], BOTS_BROWSER_HOLD_CAPABILITY) },
  'bots.browser.send': { level: 'full', local: browser(['botId', 'viewId', 'holdId', 'inputs'], BOTS_BROWSER_HOLD_CAPABILITY) },
  // The app's main process's alone: the renderer's request bridge does not offer them.
  'bots.browser.window': { level: 'local', local: browser(['botId', 'viewId', 'holdId', 'op', 'display'], BOTS_BROWSER_WINDOW_CAPABILITY) },
  'bots.browser.files': { level: 'local', local: browser(['botId', 'viewId', 'holdId', 'paths'], BOTS_BROWSER_HOLD_CAPABILITY) }
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

/** The level `name` needs: of every bot method, for the table test; another device reaches only the remote rows. */
export function botMethodLevel(name: BotMethod): BotMethodLevel {
  return row(name).level
}

/** The level a device needs to call `name` from another device: `use` or `full` (a `local` row has no `remote`). */
export function remoteBotLevel(name: RemoteBotMethod): 'use' | 'full' {
  const level = row(name).level
  if (level === 'local') throw new Error(`${name} is local`)
  return level
}

/** The bot rows of `METHOD_ACCESS`: each method another device may call, with the class of its level. */
export function botMethodAccess(): Record<RemoteBotMethod, AccessClass> {
  return Object.fromEntries(
    REMOTE_BOT_METHOD_NAMES.map((name) => [name, remoteBotLevel(name) === 'full' ? 'bots_full' : 'bots_use'])
  ) as Record<RemoteBotMethod, AccessClass>
}

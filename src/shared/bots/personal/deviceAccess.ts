import { isId } from '../../net/ids'

/**
 * Which of the owner's devices can reach a personal bot (`docs/bots.md`, Which devices reach a bot). It is kept with the
 * bot on its home computer and set there: on New bot or in the bot's About, from this computer's own window. The list is
 * explicit and starts at the bot's own computer: a new bot reaches no other device until the owner ticks it, and a device
 * linked later reaches no existing bot. A bot made from another device also reaches that device (`home_and_maker`). A
 * device that is left out finds no such bot: it is in none of its lists, and every call about it answers as for a bot
 * that is not there.
 */

/** This computer alone (the default), or this computer and the devices picked by their Net node id. */
export type BotDeviceAccess =
  | { mode: 'this_computer' }
  | { mode: 'chosen'; nodes: string[] }

export type BotDeviceAccessMode = BotDeviceAccess['mode']

/**
 * Every device, as a bot reached before the lists were explicit: what an older file says ("All my devices", or a bot
 * with no choice stored). It is read only until the one-time snapshot turns it into the devices linked at that moment
 * (`BotDeviceAccessStore.snapshot`), and never written again.
 */
export type LegacyEveryDevice = { mode: 'all' }
/** A choice as the store reads it: before the snapshot, an older file's every device too. */
export type StoredBotDeviceAccess = BotDeviceAccess | LegacyEveryDevice

/** What a bot that has no choice stored reaches: this computer alone. */
export const DEFAULT_BOT_DEVICE_ACCESS: BotDeviceAccess = Object.freeze({ mode: 'this_computer' }) as BotDeviceAccess
/** What a choice that can't be read means: this computer alone, so no device reaches the bot by mistake. */
export const UNREADABLE_BOT_DEVICE_ACCESS: BotDeviceAccess = Object.freeze({ mode: 'this_computer' }) as BotDeviceAccess

/**
 * What New bot sends (`bots.create`'s `access`): a device choice. `{ mode: 'all' }`, which an app from before the lists
 * sends for its Everywhere, is taken as this computer alone (`newBotAccessOf`).
 */
export type NewBotAccess = BotDeviceAccess | LegacyEveryDevice

/** Whether `value` is a choice New bot may send. */
export function isNewBotAccess(value: unknown): value is NewBotAccess {
  if (!!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && (value as { mode?: unknown }).mode === 'all') return true
  return botDeviceAccessProblem(value) === undefined
}

/** The choice a new bot is saved with: an older app's Everywhere is this computer alone, as every new bot starts. */
export function newBotAccessOf(access: NewBotAccess): BotDeviceAccess {
  if (access.mode === 'all') return { mode: 'this_computer' }
  return access.mode === 'chosen' ? { mode: 'chosen', nodes: [...access.nodes] } : { mode: 'this_computer' }
}

/**
 * What a device that makes a bot on another computer may ask for (`bots.create`'s `reach` there). Either way the bot
 * reaches its home computer and the device that made it (`home_and_maker`): `all`, which a phone from before the lists
 * sends, is taken as `home_and_maker`. Changing it later stays on the home computer.
 */
export const REMOTE_BOT_REACH = ['all', 'home_and_maker'] as const
export type RemoteBotReach = (typeof REMOTE_BOT_REACH)[number]

/** Most devices one bot's list holds. */
export const MAX_BOT_DEVICES = 64

/** Why `value` is not a device choice, or undefined when it is one. */
export function botDeviceAccessProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'A device choice is this_computer or chosen.'
  const access = value as { mode?: unknown; nodes?: unknown }
  const keys = Object.keys(access)
  if (access.mode === 'this_computer')
    return keys.every((key) => key === 'mode') ? undefined : 'Only chosen takes a list of devices.'
  if (access.mode !== 'chosen') return 'A device choice is this_computer or chosen.'
  if (!keys.every((key) => key === 'mode' || key === 'nodes')) return 'A device choice is a mode and its devices.'
  const nodes = access.nodes
  if (!Array.isArray(nodes) || nodes.length > MAX_BOT_DEVICES || new Set(nodes).size !== nodes.length || nodes.some((node) => !isId('node', node)))
    return `Chosen devices are up to ${MAX_BOT_DEVICES} distinct device ids.`
  return undefined
}

/** Whether `node`, one of the owner's other devices, may reach a bot with this choice (the device's own switch aside). */
export function botDeviceAllowed(access: StoredBotDeviceAccess, node: string): boolean {
  if (access.mode === 'all') return true
  if (access.mode === 'chosen') return access.nodes.includes(node)
  return false
}

/** One of the owner's other devices, as About's Devices row lists it. */
export interface BotDeviceChoice {
  node: string
  name: string
  kind: 'computer' | 'phone' | 'unknown'
  /** Its switch for bots on this computer (Settings, Devices) is off: it reaches no bot here, whatever is picked. */
  botsOff?: true
}

/**
 * The bot's choice and the devices it can name. `unreadable`: the stored choice could not be read, so it stands at this
 * computer alone until the owner picks again. Devices removed from the account are left out of `access.nodes`.
 */
export interface BotDevicesView {
  access: BotDeviceAccess
  devices: BotDeviceChoice[]
  unreadable?: true
}

/**
 * The methods of About's Devices row. Only this computer's own window and command line call them: they are not in the
 * table of methods another device may call (`REMOTE_BOT_METHODS`), never routed (`bots.` stays local), and refused
 * for a call that came through Bridge.
 */
export const BOT_DEVICE_METHODS = ['bots.devices.get', 'bots.devices.set'] as const
export type BotDeviceMethod = (typeof BOT_DEVICE_METHODS)[number]

export interface BotDeviceApi {
  'bots.devices.get': { params: { botId: string }; result: BotDevicesView }
  'bots.devices.set': { params: { botId: string; access: BotDeviceAccess }; result: BotDevicesView }
}

/** About's Devices row: what a device that is left out sees (its tooltip). */
export const BOT_DEVICES_TIP = 'A device that is left out sees nothing of this bot: it is not in its list, and its chat, memory, cards and notifications never reach it.'

/** The words a thread a bot started shows on a device that can't reach that bot ("Started by a bot"). */
export const HIDDEN_BOT_NAME = 'a bot'

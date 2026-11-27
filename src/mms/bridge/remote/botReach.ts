import type { BotReachPort } from '../../protocol/botReachPort'
import { botDeviceAllowed, HIDDEN_BOT_NAME, type StoredBotDeviceAccess } from '../../../shared/bots/personal/deviceAccess'
import type { NodeDelegation, NodeId, Roster } from '../../../shared/net'
import type { NetIdentityService } from '../../net/identity/NetIdentityService'
import type { BotDeviceAccessStore } from '../../bots/definitions/BotDeviceAccessStore'

/**
 * The owner's other devices on the account now: every node of the signed roster that is not revoked, but this one.
 * Undefined when the roster can't be read, which every caller takes as "not every device may see this".
 */
export function accountDevices(
  identity: Pick<NetIdentityService, 'self' | 'pinnedRootKey' | 'roster' | 'verifySigned'>
): NodeId[] | undefined {
  try {
    const self = identity.self()
    const root = self && identity.pinnedRootKey(self.user)
    const signed = self && identity.roster(self.user)
    if (!self || !root || !signed) return undefined
    const roster = identity.verifySigned<Roster>(signed, root)
    const current = new Map<NodeId, NodeDelegation>()
    for (const row of roster.nodes) {
      const node = identity.verifySigned<NodeDelegation>(row, root)
      const old = current.get(node.subject)
      if (!old || node.keyEpoch > old.keyEpoch || (node.keyEpoch === old.keyEpoch && node.issuedAt > old.issuedAt)) current.set(node.subject, node)
    }
    return [...current.values()]
      .filter((node) => node.subject !== self.node && !roster.revoked.some((row) => row.subject === node.subject && row.throughKeyEpoch >= node.keyEpoch))
      .map((node) => node.subject)
  } catch {
    return undefined
  }
}

/**
 * The one test of which device reaches which bot here. `access` is the bot's Devices choice (About), `deviceOn` the
 * device's switch for bots (Settings, Devices), `devices` the account's other devices that may read this computer's
 * streams (not blocked here). The device list is read again after any of `changes` fires.
 */
export function createBotReach(options: {
  access(botId: string): StoredBotDeviceAccess
  choices(): { others: StoredBotDeviceAccess; bots: StoredBotDeviceAccess[] }
  deviceOn(node: string): boolean
  devices(): readonly string[] | undefined
  changes: Array<(listener: () => void) => () => void>
}): Omit<BotReachPort, 'devices'> & { close(): void } {
  const listeners = new Set<() => void>()
  let devices: readonly string[] | undefined | null = null
  const current = (): readonly string[] | undefined => {
    if (devices === null) devices = options.devices()
    return devices
  }
  const changed = (): void => {
    devices = null
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A listener that fails does not keep the others from repushing.
      }
    }
  }
  const offs = options.changes.map((subscribe) => subscribe(changed))
  const deviceOn = (node: string): boolean => {
    try {
      return options.deviceOn(node)
    } catch {
      return false
    }
  }
  const access = (botId: string): StoredBotDeviceAccess => {
    try {
      return options.access(botId)
    } catch {
      return { mode: 'this_computer' }
    }
  }
  const canReach = (botId: string, node: string): boolean => deviceOn(node) && botDeviceAllowed(access(botId), node)
  const everyone = (botId: string): boolean => {
    const all = current()
    return all !== undefined && all.every((node) => canReach(botId, node))
  }
  /** Whether no stored choice holds a bot from `node` (from every device, without one): then nothing needs looking at. */
  const noneHeld = (node?: string): boolean => {
    let choices: { others: StoredBotDeviceAccess; bots: StoredBotDeviceAccess[] }
    try {
      choices = options.choices()
    } catch {
      return false
    }
    const allows = (choice: StoredBotDeviceAccess): boolean => (node === undefined ? choice.mode === 'all' : botDeviceAllowed(choice, node))
    return allows(choices.others) && choices.bots.every(allows)
  }
  return {
    canReach,
    deviceOn,
    everyone,
    hiddenFor: (reader) => {
      if (reader !== undefined) {
        if (!deviceOn(reader)) return () => true
        return noneHeld(reader) ? undefined : (botId) => !canReach(botId, reader)
      }
      const all = current()
      if (all === undefined) return () => true
      return noneHeld() && all.every(deviceOn) ? undefined : (botId) => !everyone(botId)
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      for (const off of offs) off()
      listeners.clear()
    }
  }
}

/**
 * `remoteBotMethods`' `madeBy`: a bot a device just made, which that device can't reach, gains that device, so it is not
 * locked out of what it made (a bot made without a choice where what is stored can't be read stands at this computer
 * alone). A bot with a choice of its own saved, the one the device asked for at creation or one set since, is never
 * widened: it stays as it was chosen.
 */
export function keepMakerInReach(
  store: Pick<BotDeviceAccessStore, 'saved' | 'set'>,
  reach: Pick<BotReachPort, 'canReach' | 'deviceOn'>,
  changed?: (botId: string) => void
): (botId: string, node: string) => void {
  return (botId, node) => {
    if (store.saved(botId) || reach.canReach(botId, node) || !reach.deviceOn(node)) return
    store.set(botId, { mode: 'chosen', nodes: [node] })
    changed?.(botId)
  }
}

type Json = unknown

/** Keys whose values never hold a thread's record, so a large transcript is not walked. */
const SKIPPED = new Set(['messages', 'content', 'text', 'images', 'scrollback'])

/**
 * A thread one of the owner's bots started names the bot (`Thread.startedByBot`, and its launcher, the bot's chat thread,
 * `createdByThreadId`). Where `hidden` says the reader may not see that bot, the thread says "a bot" instead, with no
 * bot id and no launcher, so the app shows "Started by a bot". A bot of another computer (`startedByBot.node`) is always
 * "a bot": this computer cannot tell which devices may see it (its own computer names it again, `MergedLists.withBot`).
 * Everything else is left as it is; a value with nothing to change is returned as it was.
 */
export function withHiddenBots<T>(value: T, hidden: ((botId: string) => boolean) | undefined): T {
  const walk = (item: Json, depth: number): Json => {
    if (depth > 32 || item === null || typeof item !== 'object') return item
    if (Array.isArray(item)) {
      let copy: Json[] | undefined
      item.forEach((entry, index) => {
        const next = walk(entry, depth + 1)
        if (next !== entry) (copy ??= [...item])[index] = next
      })
      return copy ?? item
    }
    const record = item as Record<string, Json>
    let copy: Record<string, Json> | undefined
    const started = record.startedByBot as { botId?: unknown; node?: unknown } | undefined
    if (started && typeof started === 'object' && typeof started.botId === 'string' && started.botId !== '' && (started.node !== undefined || hidden?.(started.botId))) {
      const { createdByThreadId: _launcher, ...rest } = record
      copy = { ...rest, startedByBot: { botId: '', name: HIDDEN_BOT_NAME } }
    }
    for (const [key, entry] of Object.entries(record)) {
      if (SKIPPED.has(key) || key === 'startedByBot') continue
      const next = walk(entry, depth + 1)
      if (next !== entry) (copy ??= { ...record })[key] = next
    }
    return copy ?? item
  }
  return walk(value, 0) as T
}

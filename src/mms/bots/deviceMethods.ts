import { BOTS_PERSONAL_V2_CAPABILITY } from '../../shared/bots/personal/methods'
import {
  BOT_DEVICE_METHODS,
  botDeviceAccessProblem,
  type BotDeviceAccess,
  type BotDeviceChoice,
  type BotDeviceMethod,
  type BotDevicesView
} from '../../shared/bots/personal/deviceAccess'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import { connectionIsLocal } from '../protocol/threadVisibility'
import { BotDefinitionError, isBotId } from './definitions/BotDefinitionStore'
import type { BotDeviceAccessStore } from './definitions/BotDeviceAccessStore'

/** What About's Devices row reads and changes, for one profile. */
export interface BotDevicesSource {
  /** Throws `bot_not_found` for a bot this profile does not have (or deleted). */
  assertBot(botId: string): void
  store: Pick<BotDeviceAccessStore, 'get' | 'set'>
  /** The owner's other devices on the account, or undefined while Bridge is off (nothing to pick from). */
  devices(): Promise<BotDeviceChoice[] | undefined>
}

/** The choice as About shows it: devices no longer on the account are left out of the list. */
async function view(source: BotDevicesSource, botId: string): Promise<BotDevicesView> {
  const { access, unreadable } = source.store.get(botId)
  const devices = (await source.devices().catch(() => undefined)) ?? []
  const known = new Set(devices.map((device) => device.node))
  const shown: BotDeviceAccess = access.mode === 'chosen' ? { mode: 'chosen', nodes: access.nodes.filter((node) => known.has(node)) } : access
  return { access: shown, devices, ...(unreadable ? { unreadable: true } : {}) }
}

function validate(method: BotDeviceMethod, value: unknown): Record<string, unknown> {
  const p = domainObject(value ?? {}, ['profileId', 'botId', ...(method === 'bots.devices.set' ? ['access'] : [])])
  if (!isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
  if (method === 'bots.devices.set') {
    const problem = botDeviceAccessProblem(p.access)
    if (problem) throw new DomainRpcError('invalid_params', problem)
  }
  return p
}

/**
 * About → Devices (`bots.devices.get`, `bots.devices.set`). Only this computer's own window and its command line reach
 * them: a call that came through Bridge (another computer's routed call) or from any other kind of client is refused, and
 * no other device has them in its table (`REMOTE_BOT_METHODS`). No bot tool, agent tool or MCP tool calls them.
 */
export function registerBotDeviceMethods(
  domains: DomainHandlerRegistry,
  sourceFor: (profileId: string) => BotDevicesSource | null | undefined | Promise<BotDevicesSource | null | undefined>
): void {
  for (const method of BOT_DEVICE_METHODS)
    domains.register({
      method,
      scope: 'profile',
      capability: BOTS_PERSONAL_V2_CAPABILITY,
      validate: (params) => validate(method, params),
      async handle(context, params, binding) {
        const connection = context.connection
        if (!connectionIsLocal(connection) || connection?.bridgeCaller)
          throw new DomainRpcError('forbidden', 'Change which devices reach a bot on its own computer.')
        try {
          const source = await sourceFor(binding!.profileId)
          if (!source) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile: their data could not be opened.')
          const botId = params.botId as string
          source.assertBot(botId)
          if (method === 'bots.devices.set') {
            const access = params.access as BotDeviceAccess
            if (access.mode === 'chosen') {
              const devices = await source.devices().catch(() => undefined)
              if (devices) {
                const known = new Set(devices.map((device) => device.node))
                if (access.nodes.some((node) => !known.has(node))) throw new DomainRpcError('invalid_params', 'One of those devices is no longer on your account.')
              }
            }
            source.store.set(botId, access)
          }
          return await view(source, botId)
        } catch (error) {
          if (error instanceof BotDefinitionError) throw new DomainRpcError(error.code, error.message)
          throw error
        }
      }
    })
}

import { isAbsolute } from 'node:path'
import type { BotMemoryForgetResult, BotMemoryListing } from '../../../shared/bots/personal/memory'
import { DomainRpcError, domainObject } from '../../protocol/domainRegistry'
import { isBotId } from '../definitions/BotDefinitionStore'
import type { BotMemoryAdmin } from '../seams'

/**
 * The handlers of the three client `bots.memory.*` methods (Bot Phase 1 §5.11). WP2 registers
 * them in `registerMethods.ts`; `bots.memory.reindex` stays an engine function until Phase 2.
 * Each takes the request's params (with `profileId`) and the profile's `BotMemoryAdmin`.
 */

export type BotMemoryMethod = 'bots.memory.list' | 'bots.memory.forget' | 'bots.memory.export'

export interface BotMemoryMethodResults {
  'bots.memory.list': BotMemoryListing
  'bots.memory.forget': BotMemoryForgetResult
  'bots.memory.export': { files: string[] }
}

type Handlers = { [M in BotMemoryMethod]: (params: unknown) => Promise<BotMemoryMethodResults[M]> }

const KEYS: Record<BotMemoryMethod, readonly string[]> = {
  'bots.memory.list': ['botId', 'history'],
  'bots.memory.forget': ['botId', 'id'],
  'bots.memory.export': ['botId', 'dir']
}

function params(method: BotMemoryMethod, value: unknown): Record<string, unknown> {
  const p = domainObject(value ?? {}, ['profileId', ...KEYS[method]])
  if (!isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
  return p
}

function rpcError(error: unknown): never {
  if (error instanceof DomainRpcError) throw error
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'not_found' || code === 'invalid_params') throw new DomainRpcError(code, message)
  if (code === 'ENOENT') throw new DomainRpcError('invalid_params', 'That folder does not exist.')
  if (code === 'EACCES' || code === 'EPERM') throw new DomainRpcError('invalid_params', "Mousse can't write to that folder.")
  throw error
}

export function botMemoryMethods(admin: BotMemoryAdmin): Handlers {
  return {
    'bots.memory.list': async (value) => {
      const p = params('bots.memory.list', value)
      if (p.history !== undefined && typeof p.history !== 'boolean') throw new DomainRpcError('invalid_params', 'history must be true or false')
      return admin.list(p.botId as string, p.history === true)
    },
    'bots.memory.forget': async (value) => {
      const p = params('bots.memory.forget', value)
      if (typeof p.id !== 'string' || !/^m\d{1,9}(?:v\d{1,9})?$/.test(p.id)) throw new DomainRpcError('invalid_params', 'A memory id like m12 is required')
      try {
        return admin.forget(p.botId as string, p.id)
      } catch (error) {
        return rpcError(error)
      }
    },
    'bots.memory.export': async (value) => {
      const p = params('bots.memory.export', value)
      if (typeof p.dir !== 'string' || !p.dir || p.dir.length > 4096 || !isAbsolute(p.dir) || p.dir.includes('\0'))
        throw new DomainRpcError('invalid_params', 'Pick a folder to save into.')
      try {
        return await admin.export(p.botId as string, p.dir)
      } catch (error) {
        return rpcError(error)
      }
    }
  }
}

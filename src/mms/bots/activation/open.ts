import { BotDefinitionStore } from '../definitions/BotDefinitionStore'
import { BotStore } from '../store/BotStore'
import { BotEngine, type BotEngineHost } from './BotEngine'

/**
 * Opens a profile's personal bots: `bots.db` and the engine over it. Null when `bots.db` cannot be
 * opened (corrupt, unreadable, or migrated by a newer build): bots are then unavailable and fail
 * closed, while the profile and its other threads work as usual.
 */
export function openPersonalBots(host: Omit<BotEngineHost, 'store' | 'definitions'>): { store: BotStore; engine: BotEngine } | null {
  let store: BotStore | undefined
  try {
    store = new BotStore({ profileHome: host.profileHome })
    const opened = store
    const definitions = new BotDefinitionStore(opened.directory, (botId) => opened.registry(botId)?.revision ?? null)
    return { store: opened, engine: new BotEngine({ ...host, store: opened, definitions }) }
  } catch (error) {
    try { store?.close() } catch { /* already unusable */ }
    console.warn('personal bots are unavailable: bots.db could not be opened', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

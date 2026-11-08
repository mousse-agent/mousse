import { BotDefinitionStore } from '../definitions/BotDefinitionStore'
import { BotStore } from '../store/BotStore'
import { BotEngine, type BotEngineHost } from './BotEngine'

/**
 * Opens a profile's personal bots: `bots.db` and the engine over it. Null when `bots.db` cannot be
 * opened (corrupt, unreadable, or migrated by a newer build): bots are then unavailable and fail
 * closed, while the profile and its other threads work as usual. The Bot UI's methods are
 * `engine.service`; the bot app tools reach the engine through `engine.tools` (`BotToolHost`).
 */
export function openPersonalBots(
  host: Omit<BotEngineHost, 'store' | 'definitions'>,
  /** The seams that need `bots.db` itself (memory, journal, packs, supervision), made once it is open and migrated. */
  seams?: (opened: { store: BotStore; definitions: BotDefinitionStore }) => Partial<Omit<BotEngineHost, 'store' | 'definitions'>>
): { store: BotStore; engine: BotEngine } | null {
  let store: BotStore | undefined
  try {
    store = new BotStore({ profileHome: host.profileHome })
    const opened = store
    const definitions = new BotDefinitionStore(opened.directory, (botId) => opened.registry(botId)?.revision ?? null)
    const engine = new BotEngine({ ...host, ...seams?.({ store: opened, definitions }), store: opened, definitions })
    // Definitions of the form editor become format 2 once, before anything reads them (Bot Phase 1 §5.2).
    engine.upgradeDefinitions()
    // The base work time is an hour: grants that still hold the old 15 minutes get it.
    engine.upgradeWorkTime()
    return { store: opened, engine }
  } catch (error) {
    try { store?.close() } catch { /* already unusable */ }
    console.warn('personal bots are unavailable: bots.db could not be opened', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

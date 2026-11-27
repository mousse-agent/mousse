import type { BotLook } from '../../../shared/bots/personal/look'

/**
 * The bots that may be an automation's Who, as data. Bots are the only reusable Who; an automation made with a saved
 * agent before they were removed keeps it until it is changed. A model is picked in the app's model picker.
 */

export interface BotChoice { id: string; name: string; look: BotLook }

/** What fills Who: the person's bots. */
export interface AutomationLibrary {
  bots: BotChoice[]
}

export const EMPTY_LIBRARY: AutomationLibrary = { bots: [] }

/** The library from the daemon's list of bots, by name. */
export function libraryFrom(input: { bots?: ReadonlyArray<{ id: string; name: string; look: BotLook }> }): AutomationLibrary {
  return { bots: (input.bots ?? []).map((bot) => ({ id: bot.id, name: bot.name, look: bot.look })).sort((a, b) => a.name.localeCompare(b.name)) }
}

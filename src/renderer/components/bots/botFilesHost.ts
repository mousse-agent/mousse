import { createContext, useContext } from 'react'

/**
 * The chat a chip or picture is in: its bot (for short names in its files folder), how it opens a file, and how it
 * says that an action on a file failed (above the composer). `remote`: the bot lives on another computer, so a path in
 * its words names a file there, never one here: it shows as plain text, and no picture is read from it.
 */
export interface BotFilesHost { botId: string; open(path: string): void; failed?(message: string): void; remote?: boolean }

export const BotFilesContext = createContext<BotFilesHost | null>(null)

/** The chat's files host, or null outside a bot's chat. */
export function useBotFiles(): BotFilesHost | null {
  return useContext(BotFilesContext)
}

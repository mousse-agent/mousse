import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { BotMemoryAdmin } from '../seams'
import { memoryRef } from '../../../shared/bots/personal/memory'
import type { BotMemoryStore } from './BotMemoryStore'
import { renderMemoryBlocks } from './render'

/**
 * The owner's side of bot memory (bot-context.md §8, §10): what `bots.memory.*` and the engine's
 * 30-day purge call. The owner forgets with chat-lane rights. Results never name a model: journal
 * rows of kind `model_change` appear only in `journal.jsonl`, which the owner asked for.
 */

export interface BotMemoryAdminOptions {
  store: BotMemoryStore
  /** The bot's definition, written as `definition.json` in an export. */
  definition?: (botId: string) => unknown
  timeZone?: () => string | undefined
}

/** A fresh folder in `dir` for one export: `bot-memory-<botId>-<date>`, then `-2`, `-3` … */
async function exportFolder(dir: string, botId: string, date: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const folder = join(dir, `bot-memory-${botId}-${date}${n > 1 ? `-${n}` : ''}`)
    try {
      await mkdir(folder, { mode: 0o700 })
      return folder
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Too many exports in that folder.')
}

export function createBotMemoryAdmin(options: BotMemoryAdminOptions): BotMemoryAdmin {
  const { store } = options
  const zone = () => options.timeZone?.() ?? store.zone()
  return {
    list: (botId, history) => store.list(botId, history),
    forget: (botId, id) => {
      const result = store.forget(botId, { id, by: 'owner_ui' })
      if ('error' in result) throw Object.assign(new Error(result.error), { code: 'not_found' })
      return result
    },
    export: async (botId, dir) => {
      if (!isAbsolute(dir)) throw Object.assign(new Error('Pick a folder to save into.'), { code: 'invalid_params' })
      if (!(await stat(dir)).isDirectory()) throw Object.assign(new Error('That is not a folder.'), { code: 'invalid_params' })
      store.expireMemories(botId)
      const { core, runNotes } = renderMemoryBlocks(store.active(botId), zone())
      const versions = store.allVersions(botId).map((version) => ({ ref: memoryRef(version.id, version.version), ...version }))
      const journal = store.journal(botId).map((row) => ({ ref: `j${row.seq}`, ...row }))
      const folder = await exportFolder(dir, botId, store.now().slice(0, 10))
      const files: Array<[string, string]> = [
        ['memory.md', `${core}\n\n${runNotes}\n`],
        ['memory.jsonl', versions.map((row) => JSON.stringify(row)).join('\n') + (versions.length ? '\n' : '')],
        ['journal.jsonl', journal.map((row) => JSON.stringify(row)).join('\n') + (journal.length ? '\n' : '')]
      ]
      const definition = options.definition?.(botId)
      if (definition !== undefined) files.push(['definition.json', `${JSON.stringify(definition, null, 2)}\n`])
      const written: string[] = []
      for (const [name, text] of files) {
        const path = join(folder, name)
        await writeFile(path, text, { mode: 0o600, flag: 'wx' })
        written.push(path)
      }
      return { files: written }
    },
    reindex: async () => {
      store.reindex()
    },
    purge: async (botId) => {
      store.purge(botId)
    }
  }
}

import { BotMemoryStore, type BotMemoryStoreOptions } from './BotMemoryStore'
import { createBotJournal, type BotJournalCaptureOptions } from './capture'
import { createBotContextProvider, type BotContextPackOptions } from './contextPack'

/** The service's memory and pack construction: local times use this process's zone, as reminder tools do. */
export function createProfileBotMemory(options: {
  memory: Omit<BotMemoryStoreOptions, 'timeZone'>
  journal: Omit<BotJournalCaptureOptions, 'store'>
  context?: Omit<BotContextPackOptions, 'store' | 'journal' | 'timeZone'>
}) {
  const memory = new BotMemoryStore(options.memory)
  const journal = createBotJournal({ ...options.journal, store: memory })
  const pack = createBotContextProvider({ ...options.context, store: memory, journal })
  return { memory, journal, pack }
}

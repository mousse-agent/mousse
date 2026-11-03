import { join } from 'node:path'
import type { WorktreeFolderStatus } from '../../shared/storage'
import type { SettingsStore } from '../settings/SettingsStore'
import { checkWorktreeFolder, folderPresent, setWorktreeFolders, worktreeFolderHoldsWorktrees } from './worktreeLayout'

/** What Settings → Storage shows of the worktree folder. Each folder is looked at once its volume answers. */
export async function worktreeFolderStatus(settings: SettingsStore, home: string): Promise<WorktreeFolderStatus> {
  const { worktreeFolder, previousWorktreeFolders } = settings.get().storage
  return {
    folder: worktreeFolder,
    defaultFolder: join(home, 'repositories'),
    connected: worktreeFolder ? await folderPresent(worktreeFolder) : true,
    previous: await Promise.all(previousWorktreeFolders.map(async (folder) => ({ folder, connected: await folderPresent(folder) })))
  }
}

/**
 * The person chose where new worktrees go: `folder`, checked first (`checkWorktreeFolder`), or null for Mousse's own.
 * Worktrees already made stay where they are: the folder they are in is kept among the previous ones, so they stay
 * Mousse's, until nothing of Mousse's is left in it (a folder that is not there counts as still holding them).
 */
export async function chooseWorktreeFolder(settings: SettingsStore, profileHome: string, home: string, folder: string | null): Promise<WorktreeFolderStatus> {
  const next = folder === null ? null : await checkWorktreeFolder(folder, home)
  const { worktreeFolder, previousWorktreeFolders } = settings.get().storage
  const candidates = [...new Set([worktreeFolder, ...previousWorktreeFolders].filter((entry): entry is string => Boolean(entry) && entry !== next))]
  const previous: string[] = []
  for (const candidate of candidates) if (await worktreeFolderHoldsWorktrees(candidate)) previous.push(candidate)
  const saved = settings.set({ storage: { worktreeFolder: next, previousWorktreeFolders: previous } })
  setWorktreeFolders(profileHome, saved.storage)
  return await worktreeFolderStatus(settings, home)
}

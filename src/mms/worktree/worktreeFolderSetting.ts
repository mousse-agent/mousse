import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorktreeFolderEntry } from '../../shared/settings'
import type { WorktreeFolderStatus } from '../../shared/storage'
import type { SettingsStore } from '../settings/SettingsStore'
import { checkWorktreeFolder, folderConnected, setWorktreeFolders, worktreeFolderStillNeeded } from './worktreeLayout'

/** What Settings → Storage shows of the worktree folder. Each folder is looked at once its volume answers, never waited on. */
export async function worktreeFolderStatus(settings: SettingsStore, home: string): Promise<WorktreeFolderStatus> {
  const { worktreeFolder, previousWorktreeFolders } = settings.get().storage
  return {
    folder: worktreeFolder?.path ?? null,
    defaultFolder: join(home, 'repositories'),
    connected: worktreeFolder ? await folderConnected(worktreeFolder.path) : true,
    previous: await Promise.all(previousWorktreeFolders.map(async (entry) => ({ folder: entry.path, connected: await folderConnected(entry.path) })))
  }
}

/**
 * The person chose where new worktrees go: `folder`, checked and marked first (`checkWorktreeFolder`), or null for
 * Mousse's own. Worktrees already made stay where they are: the folder they are in stays known, so they stay Mousse's,
 * while it is not connected, holds anything of Mousse's, or any record names a path in it (`namedPaths`).
 */
export async function chooseWorktreeFolder(settings: SettingsStore, profileHome: string, home: string, folder: string | null, namedPaths: () => Promise<string[]>): Promise<WorktreeFolderStatus> {
  const next = folder === null ? null : await checkWorktreeFolder(folder, home)
  const { worktreeFolder, previousWorktreeFolders } = settings.get().storage
  const candidates: WorktreeFolderEntry[] = []
  for (const entry of [worktreeFolder, ...previousWorktreeFolders]) if (entry && entry.path !== next?.path && !candidates.some((other) => other.path === entry.path)) candidates.push(entry)
  const named = await namedPaths()
  const previous: WorktreeFolderEntry[] = []
  for (const candidate of candidates) if (await worktreeFolderStillNeeded(candidate, named)) previous.push(candidate)
  const saved = settings.set({ storage: { worktreeFolder: next, previousWorktreeFolders: previous } })
  setWorktreeFolders(profileHome, saved.storage)
  return await worktreeFolderStatus(settings, home)
}

/**
 * Every worktree path the profile's records name: each thread's workspace and agent records (trashed threads included),
 * every reconstruction manifest (its worktree and its place in the trash), and the worktrees a dispatch left in place.
 * A chosen folder that holds any of them stays known. Read without blocking; a record that can't be read names nothing.
 */
export async function recordedWorktreePaths(store: { list(): Array<{ location: string }>; root: string } | undefined, keptWorktrees: () => Array<{ path: string }>): Promise<string[]> {
  const paths = new Set<string>()
  const add = (value: unknown): void => { if (typeof value === 'string' && value) paths.add(value) }
  const read = async (path: string): Promise<unknown> => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }
  for (const record of store?.list() ?? []) {
    const workspace = await read(join(record.location, 'workspace.json')) as { worktreePath?: unknown } | undefined
    add(workspace?.worktreePath)
    for (const name of ['agents.json', 'mousse-agent-sessions.json']) {
      const rows = await read(join(record.location, name))
      if (Array.isArray(rows)) for (const row of rows) add((row as { worktreePath?: unknown } | null)?.worktreePath)
    }
    const episodes = await read(join(record.location, 'agent-episodes.json')) as { episodes?: Array<{ binding?: { worktreePath?: unknown } }> } | undefined
    for (const episode of Array.isArray(episodes?.episodes) ? episodes!.episodes : []) add(episode?.binding?.worktreePath)
  }
  if (store) {
    const manifests = join(store.root, 'workspaces')
    let tasks: string[] = []
    try { tasks = await readdir(manifests) } catch { /* None. */ }
    for (const task of tasks) {
      let names: string[] = []
      try { names = await readdir(join(manifests, task)) } catch { continue }
      for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        const manifest = await read(join(manifests, task, name)) as { worktreePath?: unknown; trashPath?: unknown; deleting?: { path?: unknown } } | undefined
        add(manifest?.worktreePath); add(manifest?.trashPath); add(manifest?.deleting?.path)
      }
    }
  }
  for (const kept of keptWorktrees()) add(kept.path)
  return [...paths]
}

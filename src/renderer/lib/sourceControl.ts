import { create } from 'zustand'
import type {
  SourceControlMethod,
  SourceControlProviderId,
  SourceControlProviderStatus,
  SourceControlStatus,
  SourceRepository,
  SourceRepositoryList
} from '../../shared/sourceControl'
import type { Project } from '../../shared/types'

/** The computer a call goes to: another one by its node, or this one (`THIS_COMPUTER`). */
export const THIS_COMPUTER = ''

const request = <T>(method: SourceControlMethod, computer: string, params: Record<string, unknown> = {}) =>
  window.mousse.platformRequest.request<T>(method, computer ? { ...params, node: computer } : params)

/** What a clone on another computer answers: the project there, and the branch it checked out when asked for one. */
export interface RemoteClone {
  project: Project
  branch?: string
}

/** The folders of a computer by name, to pick one by browsing (`folders.browse`). */
export interface BrowsedFolders {
  path: string | null
  parent: string | null
  folders: { name: string; path: string }[]
  truncated?: boolean
}

/**
 * Settings → Source control and New project's Clone: a computer's code host accounts. Calls with another computer's
 * node go to that computer, which decides what it allows.
 */
export const sourceControlClient = {
  status: (refresh = false, computer = THIS_COMPUTER) => request<SourceControlStatus>('sourceControl.status', computer, refresh ? { refresh: true } : {}),
  connect: (provider: SourceControlProviderId, computer = THIS_COMPUTER) => request<SourceControlProviderStatus>('sourceControl.connect', computer, { provider }),
  cancel: (provider: SourceControlProviderId, computer = THIS_COMPUTER) => request<SourceControlProviderStatus>('sourceControl.cancel', computer, { provider }),
  signOut: (provider: SourceControlProviderId) => request<SourceControlProviderStatus>('sourceControl.signOut', THIS_COMPUTER, { provider }),
  repositories: (provider: SourceControlProviderId, refresh = false, computer = THIS_COMPUTER) =>
    request<SourceRepositoryList>('sourceControl.repositories', computer, refresh ? { provider, refresh: true } : { provider }),
  clone: (computer: string, input: { repository: string; path: string; branch?: string }) =>
    request<RemoteClone>('sourceControl.clone', computer, { provider: 'github', ...input }),
  browse: (computer: string, path?: string) => request<BrowsedFolders>('folders.browse', computer, path ? { path } : {})
}

/** A list this old is read again in the background the next time it is shown. */
const REPOSITORIES_STALE_MS = 5 * 60_000

export interface ComputerSourceControl {
  github: SourceControlProviderStatus | null
  repositories: SourceRepository[]
  /** When `repositories` was read, or 0 before the first read. */
  fetchedAt: number
  /** Why the last read failed (that computer is offline, or refuses), while nothing better is known. */
  error?: string
}

const EMPTY: ComputerSourceControl = Object.freeze({ github: null, repositories: [], fetchedAt: 0 }) as ComputerSourceControl

/** What this window last heard of each computer's GitHub account; New project shows it at once and reads again behind it. */
export const useSourceControl = create<{ computers: Record<string, ComputerSourceControl> }>(() => ({ computers: {} }))

/** The GitHub account and repositories of one computer, as last heard. */
export function useComputerSourceControl(computer = THIS_COMPUTER): ComputerSourceControl {
  return useSourceControl((state) => state.computers[computer] ?? EMPTY)
}

function update(computer: string, change: Partial<ComputerSourceControl>): void {
  useSourceControl.setState((state) => ({
    computers: { ...state.computers, [computer]: { ...(state.computers[computer] ?? EMPTY), ...change } }
  }))
}

/** Keeps the GitHub row of a status answer. */
export function noteGitHub(status: SourceControlProviderStatus | undefined, computer = THIS_COMPUTER): void {
  if (!status) return
  const before = useSourceControl.getState().computers[computer]?.github
  update(computer, { github: status, error: undefined })
  // Another account, or none: its repositories are not this one's.
  if (before?.account !== status.account || status.state !== 'connected') update(computer, { repositories: [], fetchedAt: 0 })
}

const refreshing = new Map<string, Promise<void>>()

/**
 * Reads a computer's GitHub account and, when it is connected and the list is missing or old, its repositories. Never
 * throws: suggestions are a help, and a failed read leaves what was there, with why it failed.
 */
export function refreshGitHubRepositories(options: { force?: boolean; computer?: string } = {}): Promise<void> {
  const computer = options.computer ?? THIS_COMPUTER
  const pending = refreshing.get(computer)
  if (pending) return pending
  const work = (async () => {
    try {
      const status = await sourceControlClient.status(false, computer)
      noteGitHub(status.providers.find((provider) => provider.id === 'github'), computer)
      const { github, fetchedAt } = useSourceControl.getState().computers[computer] ?? EMPTY
      if (github?.state !== 'connected') return
      if (!options.force && fetchedAt && Date.now() - fetchedAt < REPOSITORIES_STALE_MS) return
      const list = await sourceControlClient.repositories('github', options.force === true, computer)
      if (useSourceControl.getState().computers[computer]?.github?.account === github.account) {
        update(computer, { repositories: list.repositories, fetchedAt: list.fetchedAt || Date.now() })
      }
    } catch (error) {
      const message = (error as { message?: unknown } | null)?.message
      update(computer, { error: typeof message === 'string' && message ? message : 'Could not read GitHub' })
    } finally {
      refreshing.delete(computer)
    }
  })()
  refreshing.set(computer, work)
  return work
}

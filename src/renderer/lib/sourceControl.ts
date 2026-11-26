import { create } from 'zustand'
import type {
  SourceControlMethod,
  SourceControlProviderId,
  SourceControlProviderStatus,
  SourceControlStatus,
  SourceRepository,
  SourceRepositoryList
} from '../../shared/sourceControl'

const request = <T>(method: SourceControlMethod, params: Record<string, unknown> = {}) =>
  window.mousse.platformRequest.request<T>(method, params)

/** Settings → Source control and New project's Clone: this computer's code host accounts. */
export const sourceControlClient = {
  status: (refresh = false) => request<SourceControlStatus>('sourceControl.status', refresh ? { refresh: true } : {}),
  connect: (provider: SourceControlProviderId) => request<SourceControlProviderStatus>('sourceControl.connect', { provider }),
  cancel: (provider: SourceControlProviderId) => request<SourceControlProviderStatus>('sourceControl.cancel', { provider }),
  signOut: (provider: SourceControlProviderId) => request<SourceControlProviderStatus>('sourceControl.signOut', { provider }),
  repositories: (provider: SourceControlProviderId, refresh = false) =>
    request<SourceRepositoryList>('sourceControl.repositories', refresh ? { provider, refresh: true } : { provider })
}

/** A list this old is read again in the background the next time it is shown. */
const REPOSITORIES_STALE_MS = 5 * 60_000

interface SourceControlState {
  github: SourceControlProviderStatus | null
  repositories: SourceRepository[]
  /** When `repositories` was read, or 0 before the first read. */
  fetchedAt: number
}

/** What this window last heard; New project shows it at once and reads again behind it. */
export const useSourceControl = create<SourceControlState>(() => ({ github: null, repositories: [], fetchedAt: 0 }))

/** Keeps the GitHub row of a status answer. */
export function noteGitHub(status: SourceControlProviderStatus | undefined): void {
  if (!status) return
  const before = useSourceControl.getState().github
  useSourceControl.setState({ github: status })
  // Another account, or none: its repositories are not this one's.
  if (before?.account !== status.account || status.state !== 'connected') useSourceControl.setState({ repositories: [], fetchedAt: 0 })
}

let refreshing: Promise<void> | null = null

/**
 * Reads the GitHub account and, when it is connected and the list is missing or old, its repositories. Never throws:
 * suggestions are a help, and a failed read leaves what was there.
 */
export function refreshGitHubRepositories(options: { force?: boolean } = {}): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const status = await sourceControlClient.status()
      noteGitHub(status.providers.find((provider) => provider.id === 'github'))
      const { github, fetchedAt } = useSourceControl.getState()
      if (github?.state !== 'connected') return
      if (!options.force && fetchedAt && Date.now() - fetchedAt < REPOSITORIES_STALE_MS) return
      const list = await sourceControlClient.repositories('github', options.force === true)
      if (useSourceControl.getState().github?.account === github.account) {
        useSourceControl.setState({ repositories: list.repositories, fetchedAt: list.fetchedAt || Date.now() })
      }
    } catch {
      // Keep what was shown.
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

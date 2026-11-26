/**
 * Settings → Source control: the code hosts a computer is signed in to (GitHub for now), how to add one, and the
 * repositories of the signed-in account. Each provider is a row of `SOURCE_CONTROL_PROVIDERS`; another host is one more
 * row and one more service behind the same methods.
 */

export const SOURCE_CONTROL_METHODS = [
  'sourceControl.status',
  'sourceControl.connect',
  'sourceControl.cancel',
  'sourceControl.signOut',
  'sourceControl.repositories'
] as const
export type SourceControlMethod = (typeof SOURCE_CONTROL_METHODS)[number]

export type SourceControlProviderId = 'github'

/** The providers a computer can add, in the order Add lists them. */
export const SOURCE_CONTROL_PROVIDERS: readonly { id: SourceControlProviderId; name: string; signInUrl: string }[] = [
  { id: 'github', name: 'GitHub', signInUrl: 'https://github.com/login/device' }
]

export function isSourceControlProvider(value: unknown): value is SourceControlProviderId {
  return SOURCE_CONTROL_PROVIDERS.some((provider) => provider.id === value)
}

/** How a provider's program gets on this computer when it is missing. */
export interface SourceControlInstall {
  /** The package manager that installs it, or `manual` when none can run unattended here. */
  via: 'winget' | 'brew' | 'manual'
  /** Whether Connect installs it itself. */
  automatic: boolean
  /** The command Connect runs, shown before it does; absent for `manual`. */
  command?: string
  /** Where to read how to install it by hand. */
  url: string
}

/** What Connect is doing now. */
export type SourceControlPhase =
  /** Installing the provider's program. */
  | 'installing'
  /** Starting the sign-in. */
  | 'starting'
  /** Waiting for the person to enter `code` at `url`. */
  | 'code'
  /** Signed in; setting Git up to use the account. */
  | 'finishing'

export interface SourceControlOperation {
  id: string
  phase: SourceControlPhase
  /** The one-time code to enter at `url`, in `code`. */
  code?: string
  url?: string
}

export interface SourceControlProviderStatus {
  id: SourceControlProviderId
  name: string
  /** `missing`: the provider's program is not installed; `signed-out`: installed, no account. */
  state: 'connected' | 'signed-out' | 'missing' | 'error'
  /** The signed-in account. */
  account?: string
  /** How Connect would install the program, while it is missing. */
  install?: SourceControlInstall
  /** The Connect in progress. */
  operation?: SourceControlOperation
  /** Why the last Connect or check failed, in the program's words. */
  error?: string
}

export interface SourceControlStatus {
  providers: SourceControlProviderStatus[]
}

/** A repository of the signed-in account, its organizations, or one it collaborates on. */
export interface SourceRepository {
  /** `owner/name`. */
  nameWithOwner: string
  private: boolean
  description?: string
  /** ISO time of the last push. */
  pushedAt?: string
  fork?: boolean
}

export interface SourceRepositoryList {
  repositories: SourceRepository[]
  /** When the list was read from the provider (ms since the epoch). */
  fetchedAt: number
}

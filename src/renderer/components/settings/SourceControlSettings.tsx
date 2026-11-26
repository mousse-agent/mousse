import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { SOURCE_CONTROL_PROVIDERS, type SourceControlProviderId, type SourceControlProviderStatus } from '../../../shared/sourceControl'
import { ExternalLink, GitBranch, GitHub, Plus, RefreshCw, X } from '../../lib/icons'
import { noteGitHub, refreshGitHubRepositories, sourceControlClient, useComputerSourceControl } from '../../lib/sourceControl'
import { readableError } from '../../lib/errorText'
import { openExternalUrl } from '../PullRequestMarkdown'
import { GitHubCode } from '../GitHubCode'
import { ErrorLine } from '../ui/ErrorLine'
import { Select } from '../ui/Select'
import { Spinner } from '../ui/Spinner'
import { SettingsGroup, SettingsRow } from './SettingsRow'
import '../../styles/sourceControl.css'

/** How often the page reads a running Connect: its phase and, once gh prints it, the one-time code. */
const FOLLOW_MS = 1_000

const PHASE_TEXT = {
  installing: 'Installing GitHub CLI…',
  starting: 'Starting sign-in…',
  code: 'Enter this code on GitHub',
  finishing: 'Finishing…'
} as const
const STOPPING_TEXT = 'Finishing the install, then stopping…'

/**
 * Settings → Source control: the code hosts this computer is signed in to, and Add for the others (GitHub for now).
 * GitHub signs in through GitHub CLI: one already signed in is used as it is; Connect installs it with the platform's
 * package manager when it is missing (the command shows first), then shows the one-time code to enter on GitHub.
 */
export function SourceControlSettings() {
  const { github } = useComputerSourceControl()
  const [adding, setAdding] = useState<SourceControlProviderId | null>(null)
  const [busy, setBusy] = useState<'connect' | 'cancel' | 'signOut' | 'check' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean) => {
    try {
      const status = await sourceControlClient.status(refresh)
      noteGitHub(status.providers.find((provider) => provider.id === 'github'))
    } catch (cause) {
      setError(readableError(cause, 'Could not check GitHub'))
    }
  }, [])

  useEffect(() => { void load(true) }, [load])

  // While Connect runs, follow it; when it ends connected, New project's list is read for the new account.
  const operationId = github?.operation?.id
  useEffect(() => {
    if (!operationId) return
    const timer = setInterval(() => void load(false), FOLLOW_MS)
    return () => {
      clearInterval(timer)
      void refreshGitHubRepositories({ force: true })
    }
  }, [operationId, load])

  const act = async (kind: 'connect' | 'cancel' | 'signOut' | 'check') => {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'check') await load(true)
      else noteGitHub(await sourceControlClient[kind]('github'))
      if (kind === 'signOut') setAdding(null)
    } catch (cause) {
      setError(readableError(cause, 'Something went wrong'))
    } finally {
      setBusy(null)
    }
  }


  const shown = github && (github.state === 'connected' || github.operation || github.error || adding === 'github')
  const addable = SOURCE_CONTROL_PROVIDERS.filter((provider) => !(provider.id === 'github' && shown))

  return (
    <section id="source-control" className="settings-section">
      <SettingsGroup
        title="Accounts"
        icon={GitBranch}
        action={addable.length > 0 && (
          <Select<SourceControlProviderId>
            value=""
            onChange={(id) => setAdding(id)}
            options={addable.map((provider) => ({ value: provider.id, label: provider.name }))}
            placeholder={<span className="source-control-add"><Plus size={14} />Add</span>}
            ariaLabel="Add an account"
            size="small"
          />
        )}
      >
        {!github ? (
          <SettingsRow title="GitHub" leading={<GitHub size={18} />} description={<Spinner size={13} />} />
        ) : shown ? (
          <GitHubRow
            status={github}
            busy={busy}
            onAct={(kind) => void act(kind)}
          />
        ) : (
          <p className="settings-muted">No accounts yet.</p>
        )}
      </SettingsGroup>
      {error && <ErrorLine message={error} className="settings-status-bad" />}
    </section>
  )
}

function GitHubRow({ status, busy, onAct }: {
  status: SourceControlProviderStatus
  busy: string | null
  onAct: (kind: 'connect' | 'cancel' | 'signOut' | 'check') => void
}) {
  const operation = status.operation
  const cancel = (
    <button type="button" className="settings-icon-btn" title="Cancel" aria-label="Cancel connecting GitHub" disabled={busy !== null} onClick={() => onAct('cancel')}>
      <X size={14} />
    </button>
  )
  const check = (
    <button type="button" className="settings-icon-btn" title="Check again" aria-label="Check GitHub again" disabled={busy !== null} onClick={() => onAct('check')}>
      {busy === 'check' ? <Spinner size={13} /> : <RefreshCw size={14} />}
    </button>
  )
  const connect = (label: string) => (
    <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => onAct('connect')}>
      {busy === 'connect' ? <Spinner size={13} /> : null}
      {label}
    </button>
  )

  let description: ReactNode
  let control: ReactNode
  let body: ReactNode = null
  if (operation) {
    // Cancelled while gh installs: the installer finishes first; Connect goes on to the sign-in after it.
    description = (
      <span className="source-control-phase" title={operation.stopping ? 'An install is not stopped halfway. Nothing follows it.' : undefined}>
        {operation.phase !== 'code' && <Spinner size={13} />}{operation.stopping ? STOPPING_TEXT : PHASE_TEXT[operation.phase]}
      </span>
    )
    control = operation.stopping ? connect('Connect') : cancel
    if (operation.phase === 'code' && operation.code) body = <GitHubCode code={operation.code} url={operation.url} />
  } else if (status.state === 'connected') {
    description = <span><span className="settings-status-ok">Connected</span>{status.account ? ` · ${status.account}` : ''}</span>
    control = (
      <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => onAct('signOut')}>
        {busy === 'signOut' ? <Spinner size={13} /> : null}
        Sign out
      </button>
    )
  } else if (status.state === 'missing') {
    const install = status.install
    if (install?.automatic && install.command) {
      description = <span title="GitHub CLI installs with this command, then GitHub opens to sign in.">Installs GitHub CLI: <code>{install.command}</code></span>
      control = connect('Install and connect')
    } else {
      description = <span className="settings-status-warn">Install GitHub CLI first</span>
      control = (
        <span className="source-control-actions">
          {check}
          <button type="button" className="settings-icon-btn" title="How to install" aria-label="How to install GitHub CLI" onClick={() => openExternalUrl(install?.url ?? 'https://github.com/cli/cli#installation')}>
            <ExternalLink size={14} />
          </button>
        </span>
      )
    }
  } else if (status.state === 'error') {
    description = <span className="settings-status-bad">GitHub CLI didn’t run</span>
    control = check
  } else {
    description = <span title="Uses GitHub CLI (gh). Terminals and Git use the same account.">Not connected</span>
    control = connect('Connect')
  }

  return (
    <>
      <SettingsRow title="GitHub" anchor="source-control-github" leading={<GitHub size={18} />} description={description} control={control}>
        {body}
      </SettingsRow>
      {!operation && status.error && <ErrorLine message={status.error} className="settings-status-bad source-control-error" />}
    </>
  )
}

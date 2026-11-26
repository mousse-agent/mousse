import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { NodeId } from '../../shared/net'
import type { Project } from '../../shared/types'
import { ArrowUp, Folder, GitHub } from '../lib/icons'
import { addPlan, addTargets, cloneDestination, type AddTarget } from '../lib/addToMachine'
import type { Device } from '../lib/netDevices'
import { remoteReason } from '../lib/remoteComputers'
import { sourceControlClient, useComputerGitHub, type BrowsedFolders } from '../lib/sourceControl'
import { qualifyId } from '../../shared/threadRef'
import { GitHubCode } from './GitHubCode'
import { shortPath } from './newThreadPickerLogic'
import { Segmented } from './settings/SettingsRow'
import { Modal } from './ui/Modal'
import { Select } from './ui/Select'
import { Spinner } from './ui/Spinner'
import '../styles/settings.css'
import './addToMachine.css'

const PHASE_TEXT = { installing: 'Installing GitHub CLI…', starting: 'Starting sign-in…', code: 'Enter this code on GitHub', finishing: 'Finishing…' } as const

/**
 * Adds a project of this computer to another of the user's computers, from the composer's computer menu: a project
 * there that is already a checkout of it, or a clone of its GitHub repository (on the branch checked out here when
 * GitHub has it) into a folder there picked by browsing, with that computer's GitHub connected from here when it is
 * not. `onAdded` gets that computer's project; closing changes nothing.
 */
export function AddToMachineDialog({ project, projects, devices, withProject, notSharing, onAdded, onClose }: {
  project: Pick<Project, 'id' | 'name'>
  projects: readonly Project[]
  devices: readonly Device[]
  /** The computers that already have the project. */
  withProject: ReadonlySet<string>
  notSharing?: ReadonlySet<string>
  onAdded: (node: NodeId, project: Project) => void
  onClose: () => void
}) {
  const targets = useMemo(() => addTargets(devices, withProject, notSharing), [devices, withProject, notSharing])
  const [node, setNode] = useState<NodeId | null>(() => targets.find((target) => !target.reason)?.node ?? null)
  const target = targets.find((entry) => entry.node === node)
  const name = target?.name ?? 'that computer'
  const [source, setSource] = useState<{ repository?: string; branch?: string } | null>(null)
  useEffect(() => {
    let live = true
    void sourceControlClient.projectSource(project.id).then((found) => { if (live) setSource(found) }, () => { if (live) setSource({}) })
    return () => { live = false }
  }, [project.id])
  const plan = node && source ? addPlan({ projects, node, localProjectId: project.id, source }) : null
  const [useExisting, setUseExisting] = useState(true)
  const [folders, setFolders] = useState<Record<string, string>>({})
  const folder = node ? folders[node] ?? plan?.folder ?? null : null
  const cloning = Boolean(plan?.clone && !(plan.existing && useExisting))
  const { github, error: githubError, connect, cancel } = useComputerGitHub(cloning ? node : null, name)
  const [browsing, setBrowsing] = useState<{ view: BrowsedFolders | null; error?: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const browse = async (path?: string) => {
    if (!node) return
    setBrowsing((current) => ({ view: current?.view ?? null }))
    try {
      setBrowsing({ view: await sourceControlClient.browse(node, path) })
    } catch (failure) {
      // A folder that is gone: start from the places there.
      if (path) return browse()
      setBrowsing({ view: null, error: remoteReason(failure, name) })
    }
  }

  const add = async () => {
    if (!node || !plan || busy) return
    setError('')
    if (plan.existing && useExisting) {
      const existing = projects.find((entry) => entry.id === plan.existing!.id)
      if (existing) onAdded(node, existing)
      return
    }
    if (!plan.clone || !folder) return
    setBusy(`Cloning on ${name}…`)
    try {
      const cloned = await sourceControlClient.clone(node, {
        repository: plan.clone.repository,
        path: cloneDestination(folder, plan.clone.name),
        ...(plan.clone.branch ? { branch: plan.clone.branch } : {})
      })
      onAdded(node, { ...cloned.project, id: qualifyId(node, cloned.project.id), node, sameAs: project.id })
    } catch (failure) {
      setError(remoteReason(failure, name))
      setBusy(null)
    }
  }

  const connected = github?.state === 'connected'
  const ready = Boolean(node && plan && !busy && ((plan.existing && useExisting) || (plan.clone && folder && connected)))
  const why = !node ? 'Pick a computer' : !plan ? 'Reading the project…' : plan.existing && useExisting ? undefined
    : !plan.clone ? 'It has no GitHub remote to clone' : !folder ? 'Pick a folder there' : !connected ? `Connect GitHub on ${name} first` : undefined

  return (
    <Modal
      open
      title={`Add ${project.name} to another computer`}
      onClose={onClose}
      closeDisabled={busy !== null}
      footer={
        <button type="button" className="settings-btn primary" disabled={!ready} title={why} onClick={() => void add()}>
          {busy ? <Spinner size={13} /> : null}
          Add
        </button>
      }
    >
      <div className="add-machine">
        <div className="add-machine-project">
          {source?.repository ? <GitHub size={15} strokeWidth={2} aria-hidden="true" /> : <Folder size={15} strokeWidth={2} aria-hidden="true" />}
          <span className="add-machine-project-name">{source?.repository ?? project.name}</span>
          {source?.branch && <span className="add-machine-muted" title="The branch checked out here">{source.branch}</span>}
        </div>

        {browsing ? (
          <FolderBrowser
            computer={name}
            state={browsing}
            onOpen={(path) => void browse(path)}
            onUse={(path) => {
              if (node) setFolders((current) => ({ ...current, [node]: path }))
              setBrowsing(null)
            }}
            onBack={() => setBrowsing(null)}
          />
        ) : (
          <div className="settings-group-rows add-machine-rows">
            <Row title="Computer">
              {targets.length === 0 ? <span className="add-machine-muted">Every computer has it</span> : (
                <Select
                  size="small"
                  ariaLabel="Computer"
                  value={node ?? ''}
                  disabled={busy !== null}
                  onChange={(next) => { setNode(next as NodeId); setError('') }}
                  options={targets.map((entry) => ({ value: entry.node, textValue: entry.name, label: <TargetLabel target={entry} />, disabled: Boolean(entry.reason) }))}
                  renderValue={(option) => (option ? <TargetLabel target={targets.find((entry) => entry.node === option.value)!} /> : 'Pick a computer')}
                />
              )}
            </Row>

            {plan?.existing && plan.clone && (
              <Row title="From">
                <Segmented
                  ariaLabel="From"
                  value={useExisting ? 'existing' : 'clone'}
                  onChange={(value) => setUseExisting(value === 'existing')}
                  options={[
                    { value: 'existing', label: 'Its checkout there', title: plan.existing.path },
                    { value: 'clone', label: 'New clone', title: `Clone ${plan.clone.repository}` }
                  ]}
                />
              </Row>
            )}
            {plan?.existing && (useExisting || !plan.clone) && (
              <Row title="Checkout" description={shortPath(plan.existing.path)} />
            )}

            {cloning && plan?.clone && (
              <>
                <Row
                  title="Folder"
                  description={folder ? <span title={cloneDestination(folder, plan.clone.name)}>{shortPath(cloneDestination(folder, plan.clone.name))}</span> : 'Pick where it goes'}
                >
                  <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void browse(folder ?? undefined)}>Browse</button>
                </Row>
                <Row title="GitHub" description={<GitHubState github={github} computer={name} />}>
                  {github?.operation
                    ? !github.operation.stopping && <button type="button" className="settings-btn" onClick={() => void cancel()}>Cancel</button>
                    : github && !connected && (github.state !== 'missing' || github.install?.automatic) && (
                      <button type="button" className="settings-btn" title={`Connect GitHub on ${name}`} onClick={() => void connect()}>Connect</button>
                    )}
                </Row>
                {github?.operation?.phase === 'code' && github.operation.code && (
                  <GitHubCode code={github.operation.code} url={github.operation.url} className="add-machine-code" />
                )}
              </>
            )}
            {plan && !plan.clone && !plan.existing && (
              <Row title="Clone" description={<span title="Clones need a GitHub remote">No GitHub remote</span>} />
            )}
          </div>
        )}

        {busy && <p className="add-machine-status" role="status"><Spinner size={13} />{busy}</p>}
        {(error || githubError || browsing?.error) && <p className="chat-error" role="alert">{error || browsing?.error || githubError}</p>}
      </div>
    </Modal>
  )
}

function Row({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-item">
      <div className="settings-item-text">
        <span className="settings-item-title">{title}</span>
        {description && <div className="settings-item-desc">{description}</div>}
      </div>
      {children && <div className="settings-item-control">{children}</div>}
    </div>
  )
}

function TargetLabel({ target }: { target: AddTarget }) {
  return (
    <span className="add-machine-target" title={target.reason}>
      <span className={`add-machine-dot${target.online ? ' online' : ''}`} aria-hidden="true" />
      {target.name}
      <span className="sr-only">{target.online ? ', online' : ', offline'}</span>
    </span>
  )
}

function GitHubState({ github, computer }: { github: ReturnType<typeof useComputerGitHub>['github']; computer: string }) {
  if (!github) return <span className="add-machine-muted">Checking…</span>
  const operation = github.operation
  if (operation) {
    if (operation.stopping) return <span>Finishing the install, then stopping…</span>
    if (operation.phase === 'code' && !operation.code) return <span>Waiting for the sign-in there…</span>
    return <span>{PHASE_TEXT[operation.phase]}</span>
  }
  if (github.state === 'connected') return <span><span className="settings-status-ok">Connected</span>{github.account ? ` · ${github.account}` : ''}</span>
  if (github.state === 'missing') {
    return github.install?.automatic
      ? <span title={github.install.command}>GitHub CLI not installed; Connect installs it</span>
      : <span className="settings-status-warn" title={`Install GitHub CLI on ${computer}`}>Install GitHub CLI there first</span>
  }
  return <span className="settings-status-warn">Not connected</span>
}

/** The folders of the other computer by name: open one, go up, or use the one shown. */
function FolderBrowser({ computer, state, onOpen, onUse, onBack }: {
  computer: string
  state: { view: BrowsedFolders | null; error?: string }
  onOpen: (path: string) => void
  onUse: (path: string) => void
  onBack: () => void
}) {
  const view = state.view
  return (
    <div className="add-machine-browser" role="group" aria-label={`Folders on ${computer}`}>
      <div className="add-machine-browser-head">
        <span className="add-machine-browser-path" title={view?.path ?? undefined}>{view?.path ? shortPath(view.path) : computer}</span>
        <button type="button" className="settings-btn" onClick={onBack}>Back</button>
        <button type="button" className="settings-btn primary" disabled={!view?.path} onClick={() => view?.path && onUse(view.path)}>Use this folder</button>
      </div>
      <div className="add-machine-browser-list scrollbar-ultra-thin" role="list">
        {!view && !state.error && <div className="add-machine-muted add-machine-browser-row"><Spinner size={13} /></div>}
        {view?.parent && (
          <button type="button" role="listitem" className="add-machine-browser-row" onClick={() => onOpen(view.parent!)}>
            <ArrowUp size={14} aria-hidden="true" />..
          </button>
        )}
        {view?.folders.map((entry) => (
          <button key={entry.path} type="button" role="listitem" className="add-machine-browser-row" onClick={() => onOpen(entry.path)}>
            <Folder size={14} aria-hidden="true" />{entry.name}
          </button>
        ))}
        {view && view.folders.length === 0 && <div className="add-machine-muted add-machine-browser-row">No folders here</div>}
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { describeStatus, type InstanceSnapshot } from '../../../shared/harness/status'
import type { ProviderAddOption } from '../../../shared/harness/types'
import type { Project } from '../../../shared/types'
import { isThreadStarted } from '../../../shared/threadTitle'
import { runWithToast } from '../../lib/actionToast'
import { Check, ExternalLink, FolderOpen, GitFork, KeyRound, Laptop, Smartphone, X } from '../../lib/icons'
import { phonesBlocked } from '../../lib/plusEnrollment'
import { formatCountdown, secondsLeft } from '../../lib/plusSignIn'
import { profilePreferenceKey } from '../../lib/profilePreferences'
import { DEVICE_SCOPE, sortInstances, useProviderSnapshots, watchPendingSignIn } from '../../lib/providerSnapshots'
import { ProviderIcon } from '../../lib/providerIcons'
import { openAddProvider, openSettingsSection } from '../../lib/settingsNavigation'
import { listProjectAndStartThread } from '../../lib/threadActions'
import { useAppStore } from '../../stores/appStore'
import { mousseIdSignedIn, useMousseId, useMousseIdAvailable } from '../../stores/mousseIdStore'
import { AddPhoneDialog } from '../MousseIdSection'
import { MousseLogoOutline } from '../MousseLogoOutline'
import { CommandBox } from '../providers/parts'
import { formatVersion, iconIdOf, isApiInstance } from '../providers/providerView'
import { shortPath } from '../newThreadPickerLogic'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { Spinner } from '../ui/Spinner'
import { WizardSteps } from '../ui/WizardSteps'
import { WindowCaptionButtons } from '../WindowCaptionButtons'
import '../../styles/settings.css'
import '../../styles/providers.css'
import './onboarding.css'

/** Finished or skipped, per profile, on this computer. */
const DONE_PREFERENCE = 'setup.done'
const STEPS = ['Connect an AI', 'Pick a project', 'Your phone'] as const

function setupDone(profileId: string): boolean {
  try {
    return localStorage.getItem(profilePreferenceKey(profileId, DONE_PREFERENCE)) === 'done'
  } catch {
    return false
  }
}

/** First-run setup: open, which step, and the project picked on step 2. */
export const useOnboarding = create<{ open: boolean; step: number; projectId: string | null }>(() => ({
  open: false,
  step: 0,
  projectId: null
}))

/**
 * First-run setup, over the whole window. It opens once per profile, on a fresh one: no projects, no
 * started threads, never finished or skipped.
 */
export function OnboardingHost() {
  const workspaceReady = useAppStore((state) => state.workspaceReady)
  const profileId = useAppStore((state) => state.profileId)
  const open = useOnboarding((state) => state.open)
  const decided = useRef<string | null>(null)
  useEffect(() => {
    if (!workspaceReady || !profileId || decided.current === profileId) return
    decided.current = profileId
    const { projects, threads } = useAppStore.getState()
    const fresh = !setupDone(profileId) && projects.length === 0 && !threads.some(isThreadStarted)
    useOnboarding.setState(fresh ? { open: true, step: 0, projectId: null } : { open: false })
  }, [workspaceReady, profileId])
  return open ? <Onboarding /> : null
}

/** Done, or Skip on the last step: never again for this profile, and a new thread in the picked project. */
function finish(project: Project | undefined): void {
  const profileId = useAppStore.getState().profileId
  try {
    if (profileId) localStorage.setItem(profilePreferenceKey(profileId, DONE_PREFERENCE), 'done')
  } catch {
    // No storage: setup closes now and may show again on the next start.
  }
  useOnboarding.setState({ open: false })
  if (project) void runWithToast('start a thread', () => listProjectAndStartThread(project), { retry: true })
}

function Onboarding() {
  const { step, projectId } = useOnboarding()
  const project = useAppStore((state) => state.projects.find((entry) => entry.id === projectId))
  // Builds without Mousse ID, or with it off in Labs, have no phone step.
  const steps = useMousseIdAvailable() ? STEPS : STEPS.slice(0, 2)
  const current = Math.min(step, steps.length - 1)
  const go = (next: number) => useOnboarding.setState({ step: next })
  const next = (from: number) => (from < steps.length - 1 ? go(from + 1) : finish(project))
  const nextLabel = (from: number) => (from < steps.length - 1 ? 'Continue' : 'Done')
  return (
    <section className="onb-page settings-scope overlay-page" aria-label="Set up Mousse">
      <header className="overlay-titlebar overlay-page-drag-header onb-titlebar">
        <MousseLogoOutline className="onb-titlebar-logo" />
        <h1>Set up Mousse</h1>
        <div className="titlebar-controls overlay-titlebar-controls">
          <WindowCaptionButtons />
        </div>
      </header>
      <div className="onb-body">
        <div className="onb-column">
          <WizardSteps steps={steps} current={current} onStep={go} />
          {current === 0 && <ConnectStep onNext={() => next(0)} nextLabel={nextLabel(0)} />}
          {current === 1 && <ProjectStep project={project} onBack={() => go(0)} onNext={() => next(1)} nextLabel={nextLabel(1)} />}
          {current === 2 && <PhoneStep onBack={() => go(1)} onDone={() => finish(project)} />}
        </div>
      </div>
    </section>
  )
}

function StepHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="onb-head">
      <h2 className="onb-title">{title}</h2>
      <p className="onb-lead">{children}</p>
    </div>
  )
}

function Footer({ onBack, skip, next, nextLabel, nextDisabled }: {
  onBack?: () => void
  skip?: () => void
  next: () => void
  nextLabel: string
  nextDisabled?: boolean
}) {
  return (
    <div className="onb-footer">
      {onBack ? <button type="button" className="settings-btn onb-btn" onClick={onBack}>Back</button> : <span />}
      <div className="onb-footer-end">
        {skip && <button type="button" className="settings-btn onb-btn onb-btn-quiet" onClick={skip}>Skip</button>}
        <button type="button" className="btn btn-primary onb-btn onb-btn-primary" disabled={nextDisabled} onClick={next}>{nextLabel}</button>
      </div>
    </div>
  )
}

const ready = (snapshot: InstanceSnapshot) => describeStatus(snapshot).tone === 'ready'

/** Step 1: each coding agent found on this computer, with the one thing it needs. */
function ConnectStep({ onNext, nextLabel }: { onNext: () => void; nextLabel: string }) {
  const { snapshots } = useProviderSnapshots(DEVICE_SCOPE)
  const [apiOptions, setApiOptions] = useState<ProviderAddOption[]>([])
  useEffect(() => {
    void window.mousse.providers.catalog.addOptions().then(setApiOptions).catch(() => {})
  }, [])
  const agents = useMemo(() => sortInstances((snapshots ?? []).filter((entry) => !isApiInstance(entry))), [snapshots])
  // Model APIs show once one is connected (Add key below); the catalog's are not listed one by one.
  const apis = useMemo(() => (snapshots ?? []).filter((entry) => isApiInstance(entry) && ready(entry)), [snapshots])
  const anyReady = (snapshots ?? []).some(ready)
  const named = ['OpenAI', 'Anthropic', 'Google', 'OpenRouter']
  const more = Math.max(apiOptions.length - named.length, 0)

  return (
    <>
      <StepHead title="Connect an AI">
        Mousse runs coding agents on this computer, signed in to your own accounts. Sign in to at least one.
      </StepHead>
      <SettingsGroup className="onb-group">
        {!snapshots && <SettingsRow title="Looking for agents on this computer…" control={<Spinner size={14} />} />}
        {[...agents, ...apis].map((snapshot) => <AgentRow key={snapshot.instanceId} snapshot={snapshot} />)}
        <SettingsRow
          leading={<span className="onb-lead-icon"><KeyRound size={16} /></span>}
          title="API key"
          description={more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ')}
          control={<button type="button" className="settings-btn onb-btn" onClick={openAddProvider}>Add key</button>}
        />
      </SettingsGroup>
      <Footer skip={onNext} next={onNext} nextLabel={nextLabel} nextDisabled={!anyReady} />
    </>
  )
}

function AgentRow({ snapshot }: { snapshot: InstanceSnapshot }) {
  const status = describeStatus(snapshot)
  const [busy, setBusy] = useState(false)
  const version = formatVersion(snapshot.binary?.version)
  const step = status.nextStep
  const title = (
    <span className="onb-agent-name">
      {snapshot.displayName}
      {version && <span className="onb-agent-version">{version}</span>}
    </span>
  )
  const run = (work: () => Promise<unknown>) => {
    setBusy(true)
    void work().catch(() => {}).finally(() => setBusy(false))
  }
  let description: ReactNode = status.headline
  let control: ReactNode = null
  if (status.tone === 'ready') {
    const account = snapshot.auth.account?.label
    description = <span className="onb-ok"><Check size={13} strokeWidth={2.4} />{account ? `Signed in · ${account}` : 'Ready'}</span>
  } else if (step?.action === 'sign_in' && step.command && snapshot.auth.canSignIn !== true) {
    description = 'Not signed in · run this in a terminal'
    control = <CommandBox command={step.command} label="Copy sign-in command" onCopy={() => watchPendingSignIn(snapshot.instanceId)} />
  } else if (step?.action === 'sign_in') {
    description = 'Not signed in'
    control = <button type="button" className="settings-btn onb-btn" disabled={busy} onClick={() => run(() => window.mousse.providers.instances.signIn(snapshot.instanceId))}>{step.label}</button>
  } else if (step?.action === 'install') {
    description = 'Not installed'
    control = <button type="button" className="settings-btn onb-btn" disabled={busy} onClick={() => run(() => window.mousse.providers.instances.install(snapshot.instanceId))}>Install</button>
  } else if (status.headline === 'Installing' || status.headline === 'Checking status') {
    control = <Spinner size={14} />
  }
  return (
    <SettingsRow
      leading={<ProviderIcon providerId={iconIdOf(snapshot)} size={20} />}
      title={title}
      description={description}
      control={control}
    />
  )
}

/** Step 2: the folder agents work in. A project New project adds (Clone) is picked here too. */
function ProjectStep({ project, onBack, onNext, nextLabel }: {
  project: Project | undefined
  onBack: () => void
  onNext: () => void
  nextLabel: string
}) {
  const [busy, setBusy] = useState(false)
  const projects = useAppStore((state) => state.projects)
  const known = useRef<ReadonlySet<string> | null>(null)
  known.current ??= new Set(projects.map((entry) => entry.id))
  useEffect(() => {
    if (project) return
    const added = projects.find((entry) => !known.current?.has(entry.id))
    if (added) useOnboarding.setState({ projectId: added.id })
  }, [projects, project])
  const pick = async () => {
    setBusy(true)
    try {
      const opened = await window.mousse.projects.open()
      if (opened) {
        const store = useAppStore.getState()
        if (!store.projects.some((entry) => entry.id === opened.id)) store.setProjects([...store.projects, opened])
        useOnboarding.setState({ projectId: opened.id })
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <StepHead title="Pick a project">
        The folder your agents work in. In a Git repository each thread gets its own branch, so your checkout stays as it is.
      </StepHead>
      <SettingsGroup className="onb-group">
        {project ? (
          <SettingsRow
            leading={<span className="onb-lead-icon"><FolderOpen size={16} /></span>}
            title={project.name}
            description={<span className="onb-ok"><Check size={13} strokeWidth={2.4} />{shortPath(project.path)}</span>}
            control={<button type="button" className="settings-btn onb-btn" disabled={busy} onClick={() => void pick()}>Change</button>}
          />
        ) : (
          <>
            <SettingsRow
              leading={<span className="onb-lead-icon"><FolderOpen size={16} /></span>}
              title="Open a folder"
              description="Any folder on this computer"
              control={<button type="button" className="settings-btn onb-btn" disabled={busy} onClick={() => void pick()}>Choose folder</button>}
            />
            <SettingsRow
              leading={<span className="onb-lead-icon"><GitFork size={16} /></span>}
              title="Clone from GitHub"
              description="A repository URL or owner/name"
              control={<button type="button" className="settings-btn onb-btn" onClick={() => useAppStore.getState().setNewProjectOpen(true)}>Clone</button>}
            />
          </>
        )}
      </SettingsGroup>
      <Footer onBack={onBack} skip={project ? undefined : onNext} next={onNext} nextLabel={nextLabel} nextDisabled={!project} />
    </>
  )
}

/**
 * Step 3, optional: Mousse ID on this computer, and a phone on the same account. A phone signed in
 * to the same Mousse ID joins this computer's devices without an approval.
 */
function PhoneStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const state = useMousseId()
  const { plus, net, pending, busy, error } = state
  const signedIn = mousseIdSignedIn(plus)
  // Only the computer that owns the devices list makes a phone code; a phone still joins by signing in.
  const canAddPhone = !phonesBlocked(net, plus)
  const [addingPhone, setAddingPhone] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pending])
  const who = plus?.email ?? (plus?.accountId ? `Account ${plus.accountId}` : undefined)
  const signIn = async () => {
    // A profile waiting to join another device's network finishes that under Settings → Devices.
    if (await state.signIn() === 'needs-setup') openSettingsSection('connections')
  }

  return (
    <>
      <StepHead title="Your phone">
        Optional. Sign in to Mousse ID to reach this computer from your phone and your other computers.
      </StepHead>
      <SettingsGroup className="onb-group">
        <SettingsRow
          leading={<span className="onb-lead-icon"><Laptop size={16} /></span>}
          title="This computer"
          description={signedIn
            ? <span className="onb-ok"><Check size={13} strokeWidth={2.4} />{who ? `Signed in · ${who}` : 'Signed in'}</span>
            : pending ? 'Signing in to Mousse ID…' : 'Not signed in to Mousse ID'}
          control={!signedIn && !pending && (
            <button type="button" className="settings-btn onb-btn" disabled={busy} onClick={() => void signIn()}>Sign in</button>
          )}
        />
        {pending && (
          <SettingsRow
            indent
            title="Finish in your browser"
            description={<>Check that it shows <strong className="onb-code">{pending.userCode}</strong> · {formatCountdown(secondsLeft(pending.expiresAt, now))} left</>}
            control={
              <span className="settings-icon-actions">
                <a className="settings-icon-btn primary account-link-btn" href={pending.verificationUri} target="_blank" rel="noreferrer" title="Open page" aria-label="Open page">
                  <ExternalLink size={14} />
                </a>
                <button type="button" className="settings-icon-btn" title="Cancel sign-in" aria-label="Cancel sign-in" onClick={state.cancelSignIn}>
                  <X size={14} />
                </button>
              </span>
            }
          />
        )}
        <SettingsRow
          leading={<span className="onb-lead-icon"><Smartphone size={16} /></span>}
          title="Phone"
          description="In the Mousse app, sign in with the same Mousse ID. No approval needed."
          control={(canAddPhone || !signedIn) && (
            <button
              type="button"
              className="settings-btn onb-btn"
              disabled={!canAddPhone}
              title={canAddPhone ? 'Show a code to scan with the Mousse app' : 'Sign in this computer first'}
              onClick={() => setAddingPhone(true)}
            >
              Add phone
            </button>
          )}
        />
      </SettingsGroup>
      {error && <p className="onb-error" role="alert">{error}</p>}
      {/* Optional step: Done always finishes; a sign-in still in progress completes on its own. */}
      <Footer onBack={onBack} next={onDone} nextLabel="Done" />
      {addingPhone && <AddPhoneDialog onClose={() => setAddingPhone(false)} />}
    </>
  )
}

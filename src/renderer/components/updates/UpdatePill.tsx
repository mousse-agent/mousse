import { useEffect, useRef, useState, type RefObject } from 'react'
import { isTurnActivePhase } from '../../../shared/types'
import type { UpdateState } from '../../../shared/updates'
import { CircleAlert, CircleCheck, Download, Loader2, X } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition } from '../../lib/floatingLayer'
import { useAppStore } from '../../stores/appStore'
import { subscribeToUpdates, updateActions, updateNeedsAttention, useUpdateStore } from '../../stores/updateStore'
import { Modal } from '../ui/Modal'
import '../../styles/updates.css'

function title(state: UpdateState): string {
  switch (state.phase) {
    case 'available': return 'Update available'
    case 'downloading': return 'Downloading update'
    case 'downloaded': return state.error ? 'Update not installed' : 'Update ready to install'
    case 'installing': return 'Installing update'
    default: return state.error?.during === 'download' ? 'Download failed' : 'Update'
  }
}

type PillStage = 'offer' | 'downloading' | 'ready' | 'retry-install' | 'installing' | 'failed'

function pillStage(phase: UpdateState['phase'], failed: boolean): PillStage {
  if (phase === 'downloading') return 'downloading'
  if (phase === 'downloaded') return failed ? 'retry-install' : 'ready'
  if (phase === 'installing') return 'installing'
  return phase === 'error' ? 'failed' : 'offer'
}

const PILL_LABEL: Record<PillStage, string> = {
  offer: 'Update available',
  downloading: 'Downloading',
  ready: 'Ready to update',
  'retry-install': 'Update not installed',
  installing: 'Installing update',
  failed: 'Download failed'
}

const PILL_ACTION: Partial<Record<PillStage, string>> = {
  offer: 'Download',
  ready: 'Restart',
  'retry-install': 'Try again',
  failed: 'Retry'
}

const RING_RADIUS = 9
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** Download progress drawn around the pill's icon; spins until the first progress report. */
function ProgressRing({ percent }: { percent: number | undefined }) {
  const known = percent !== undefined && percent > 0
  return (
    <svg className={`update-pill-ring${known ? '' : ' indeterminate'}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="update-pill-ring-track" cx="12" cy="12" r={RING_RADIUS} />
      <circle className="update-pill-ring-value" cx="12" cy="12" r={RING_RADIUS}
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - (known ? percent : 25) / 100)} />
    </svg>
  )
}

function PillIcon({ stage, percent }: { stage: PillStage; percent: number | undefined }) {
  switch (stage) {
    case 'downloading': return <ProgressRing percent={percent} />
    case 'ready': return <CircleCheck size={18} strokeWidth={1.8} aria-hidden="true" />
    case 'installing': return <Loader2 size={18} strokeWidth={1.8} className="spin" aria-hidden="true" />
    case 'failed':
    case 'retry-install': return <CircleAlert size={18} strokeWidth={1.8} aria-hidden="true" />
    default: return <Download size={18} strokeWidth={1.8} aria-hidden="true" />
  }
}

/**
 * Floating pill in the bottom-right corner, shown only while an update needs attention. It
 * carries the next action and the download progress; its label opens the details popover.
 */
export function UpdatePill() {
  // Each selector changes only when what the pill shows changes, not on every state push.
  const visible = useUpdateStore(updateNeedsAttention)
  const phase = useUpdateStore((s) => s.phase)
  const failed = useUpdateStore((s) => Boolean(s.error && s.error.during !== 'check'))
  const version = useUpdateStore((s) => s.availableVersion)
  const percent = useUpdateStore((s) => s.downloadPercent)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Hiding lasts until the update reaches its next stage, a newer version arrives, or Mousse restarts.
  const [hidden, setHidden] = useState<string>()
  const pillRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => subscribeToUpdates(), [])
  const stage = pillStage(phase, failed)
  const key = `${version ?? ''}:${stage}`
  const shown = visible && hidden !== key
  useEffect(() => {
    if (!shown) setOpen(false)
  }, [shown])

  const act = () => {
    if (stage === 'ready' || stage === 'retry-install') {
      setOpen(false)
      setConfirming(true)
    } else {
      void updateActions.download()
    }
  }
  const action = PILL_ACTION[stage]
  const detail = stage === 'downloading' ? (percent ? `${percent}%` : undefined) : version
  return (
    <>
      {shown && <div ref={pillRef} className={`update-pill update-pill-${stage}`}
        style={stage === 'downloading' ? { ['--update-progress' as string]: `${percent ?? 0}%` } : undefined}>
        <button ref={labelRef} type="button" className="update-pill-label" aria-haspopup="dialog" aria-expanded={open}
          title="Show what's changed" onClick={() => setOpen((value) => !value)}>
          <span className="update-pill-icon"><PillIcon stage={stage} percent={percent} /></span>
          <strong>{PILL_LABEL[stage]}</strong>
          {detail && <span className="update-pill-detail">{detail}</span>}
        </button>
        {action && <button type="button" className="update-pill-action" onClick={act}>{action}</button>}
        {stage !== 'installing' && <button type="button" className="update-pill-hide" aria-label="Hide for now"
          title="Hide for now" onClick={() => setHidden(key)}>
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>}
        <span className="update-pill-sr" role="status">{stage === 'downloading' ? '' : PILL_LABEL[stage]}</span>
      </div>}
      {shown && open && <UpdatePopover anchorRef={pillRef} returnFocusRef={labelRef} onClose={() => setOpen(false)} />}
      <InstallConfirm open={confirming} version={version ?? ''} onClose={() => setConfirming(false)} />
    </>
  )
}

/** What the update brings; its actions stay on the pill. */
function UpdatePopover({ anchorRef, returnFocusRef, onClose }: {
  anchorRef: RefObject<HTMLElement | null>
  returnFocusRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const state = useUpdateStore()
  const contentRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({
    open: true, anchorRef, contentRef, placement: 'above-end', deps: [state.phase, state.releaseNotes]
  })

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || contentRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
      returnFocusRef.current?.focus()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose, returnFocusRef])

  return (
    <FloatingPortal>
      <div ref={contentRef} className="update-popover" role="dialog" aria-label={title(state)} style={style}>
        <header className="update-popover-header">
          <h2>{title(state)}</h2>
          {state.availableVersion && <p>{state.availableVersion}</p>}
        </header>
        {state.notAppliedVersion && state.notAppliedVersion === state.availableVersion &&
          <p className="update-popover-note">This update did not install last time. Try again.</p>}
        {state.error && state.error.during !== 'check' &&
          <p className="update-popover-error" role="alert">{state.error.message}</p>}
        <ReleaseNotes state={state} />
      </div>
    </FloatingPortal>
  )
}

function ReleaseNotes({ state }: { state: UpdateState }) {
  const groups = state.releaseNotes.filter((group) => group.items.length > 0)
  if (groups.length === 0) return null
  return (
    <section className="update-notes" aria-label="What's changed">
      <h3>What's changed</h3>
      {groups.map((group) => {
        const more = group.totalItems - group.items.length
        return (
          <div key={group.version} className="update-notes-group">
            {groups.length > 1 && <h4>{group.version}</h4>}
            <ul>{group.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
            <a href={group.url} target="_blank" rel="noopener noreferrer">
              {more > 0 ? `${more} more change${more === 1 ? '' : 's'} on GitHub` : 'View release on GitHub'}
            </a>
          </div>
        )
      })}
      {state.omittedReleaseCount > 0 &&
        <p className="update-notes-more">{state.omittedReleaseCount} earlier release{state.omittedReleaseCount === 1 ? '' : 's'} not shown</p>}
    </section>
  )
}

function InstallConfirm({ open, version, onClose }: { open: boolean; version: string; onClose: () => void }) {
  const running = useAppStore((s) => Object.values(s.turnStates).filter((turn) => isTurnActivePhase(turn.phase)).length)
  // The floating layer sits above the pill and any open popover.
  return (
    <FloatingPortal>
      <Modal open={open} title={`Restart to install ${version}?`} onClose={onClose} footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => { onClose(); void updateActions.install() }}>Restart and update</button>
      </>}>
        <p>Mousse will close, stop its background service, install the update and open again.</p>
        <p>{running > 0
          ? `${running} agent turn${running === 1 ? ' is' : 's are'} running. ${running === 1 ? 'It' : 'They'} will be stopped and marked interrupted; you can continue after the update.`
          : 'Any running agent turns will be stopped and marked interrupted.'}</p>
      </Modal>
    </FloatingPortal>
  )
}

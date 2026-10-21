import { useEffect, useRef, useState, type RefObject } from 'react'
import { isTurnActivePhase } from '../../../shared/types'
import type { UpdateState } from '../../../shared/updates'
import { Download } from '../../lib/icons'
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

/** Left-rail button shown only while an update needs attention, with its details popover. */
export function UpdateRailButton() {
  // The rail re-renders only when the button appears, disappears or changes its label.
  const visible = useUpdateStore(updateNeedsAttention)
  const phase = useUpdateStore((s) => s.phase)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => subscribeToUpdates(), [])
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  if (!visible) return null
  const label = phase === 'downloaded' ? 'Update ready to install' : phase === 'downloading' ? 'Downloading update' : 'Update available'
  return (
    <>
      <button ref={buttonRef} type="button" className={`navigation-rail-button update-rail-button${open ? ' active' : ''}`}
        aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <Download size={18} strokeWidth={1.8} aria-hidden="true" />
        <span className={`update-rail-badge${phase === 'downloaded' ? ' ready' : ''}`} aria-hidden="true" />
      </button>
      {open && <UpdatePopover anchorRef={buttonRef} onClose={() => setOpen(false)} />}
    </>
  )
}

function UpdatePopover({ anchorRef, onClose }: { anchorRef: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const state = useUpdateStore()
  const contentRef = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const style = useFloatingPosition({
    open: true, anchorRef, contentRef, placement: 'right-end', deps: [state.phase, state.releaseNotes]
  })

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (confirming || anchorRef.current?.contains(target) || contentRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirming) return
      event.preventDefault()
      onClose()
      anchorRef.current?.focus()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, confirming, onClose])

  const retry = state.phase === 'error' && state.error?.during === 'download'
  return (
    <FloatingPortal>
      {/* The confirmation replaces the popover; the floating layer sits above modal backdrops. */}
      {!confirming && <div ref={contentRef} className="update-popover" role="dialog" aria-label={title(state)} style={style}>
        <header className="update-popover-header">
          <h2>{title(state)}</h2>
          {state.availableVersion && <p>{state.availableVersion}</p>}
        </header>
        {state.notAppliedVersion && state.notAppliedVersion === state.availableVersion &&
          <p className="update-popover-note">This update did not install last time. Try again.</p>}
        {state.error && state.error.during !== 'check' &&
          <p className="update-popover-error" role="alert">{state.error.message}</p>}
        <ReleaseNotes state={state} />
        <footer className="update-popover-footer">
          {state.phase === 'downloading'
            ? <div className="update-progress" role="progressbar" aria-label="Download progress"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.downloadPercent ?? 0}>
                <span style={{ width: `${state.downloadPercent ?? 0}%` }} />
                <em>{state.downloadPercent ?? 0}%</em>
              </div>
            : state.phase === 'downloaded'
              ? <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>Restart to update</button>
              : state.phase === 'installing'
                ? <button type="button" className="btn btn-primary" disabled>Installing…</button>
                : <button type="button" className="btn btn-primary" onClick={() => void updateActions.download()}>
                    {retry ? 'Try again' : 'Download'}
                  </button>}
        </footer>
      </div>}
      <InstallConfirm open={confirming} version={state.availableVersion ?? ''} onClose={() => setConfirming(false)} />
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
  return (
    <Modal open={open} title={`Restart to install ${version}?`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={() => { onClose(); void updateActions.install() }}>Restart and update</button>
    </>}>
      <p>Mousse will close, stop its background service, install the update and open again.</p>
      <p>{running > 0
        ? `${running} agent turn${running === 1 ? ' is' : 's are'} running. ${running === 1 ? 'It' : 'They'} will be stopped and marked interrupted; you can continue after the update.`
        : 'Any running agent turns will be stopped and marked interrupted.'}</p>
    </Modal>
  )
}

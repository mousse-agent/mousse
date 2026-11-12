import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowUp, Check, CircleAlert, CircleCheck, Copy, Download, Info, Loader2, Mic, RotateCcw, Settings, VolumeHigh, X, type LucideIcon } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition, type FloatingPlacement } from '../../lib/floatingLayer'
import { ProviderIcon } from '../../lib/providerIcons'
import { openSettingsSection } from '../../lib/settingsNavigation'
import {
  downloadsActions,
  isActiveDownload,
  subscribeToDownloads,
  summarizeDownloads,
  updatableAgents,
  useDownloadsStore,
  type DownloadEntry,
  type DownloadKind,
  type DownloadsSummary
} from '../../stores/downloadsStore'
import { updateActions, useUpdateStore } from '../../stores/updateStore'
import { InstallConfirm, ReleaseNotes } from '../updates/InstallConfirm'
import { formatVersion, iconIdOf } from '../providers/providerView'
import '../../styles/downloads.css'

/**
 * One indicator for every download and update (the app, the agent CLIs on this computer, dictation
 * and read-aloud models). The narrow
 * navigation rail shows an icon with a progress ring and a count; the Settings nav adds a short
 * label. Hidden when nothing is downloading, failed, offered or ready. Clicking opens the list.
 */

export type DownloadsIndicatorVariant = 'rail' | 'nav'

const RING_R = 10
const RING_C = 2 * Math.PI * RING_R

/** Accent progress ring; spins while the size or progress is not known yet. */
export function ProgressRing({ percent }: { percent?: number }) {
  const known = percent !== undefined && percent > 0
  return (
    <svg className={`downloads-ring${known ? '' : ' indeterminate'}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="downloads-ring-track" cx="12" cy="12" r={RING_R} />
      <circle className="downloads-ring-fill" cx="12" cy="12" r={RING_R}
        strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - (known ? percent : 25) / 100)} />
    </svg>
  )
}

/** The indicator's icon for the most urgent state. */
function SummaryGlyph({ summary, size }: { summary: DownloadsSummary; size: number }) {
  switch (summary.status) {
    case 'downloading':
      return (
        <span className="downloads-glyph">
          <ProgressRing percent={summary.percent} />
          <Download size={size - 4} strokeWidth={1.8} aria-hidden="true" />
        </span>
      )
    case 'installing': return <Loader2 size={size} strokeWidth={1.8} className="spin" aria-hidden="true" />
    case 'failed': return <CircleAlert size={size} strokeWidth={1.8} className="downloads-bad" aria-hidden="true" />
    case 'done': return <CircleCheck size={size} strokeWidth={1.8} className="downloads-ok" aria-hidden="true" />
    default: return <Download size={size} strokeWidth={1.8} aria-hidden="true" />
  }
}

export function DownloadsIndicator({ variant }: { variant: DownloadsIndicatorVariant }) {
  useEffect(() => subscribeToDownloads(), [])
  const entries = useDownloadsStore((s) => s.entries)
  const version = useUpdateStore((s) => s.availableVersion)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const summary = summarizeDownloads(entries)

  const toggle = (next: boolean): void => {
    setOpen(next)
    downloadsActions.setPinned(next)
  }
  // An open popover holds finished entries; release them if this indicator goes away.
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => () => {
    if (openRef.current) downloadsActions.setPinned(false)
  }, [])

  const visible = summary.status !== 'idle' || open
  const label = summary.label || 'Downloads'
  const rail = variant === 'rail'
  const button = (
        <button
          ref={buttonRef}
          type="button"
          className={rail ? `navigation-rail-button downloads-rail${open ? ' active' : ''}` : `downloads-nav${open ? ' active' : ''}`}
          data-status={summary.status}
          aria-label={label}
          title={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => toggle(!open)}
        >
          {rail ? (
            <>
              <SummaryGlyph summary={summary} size={18} />
              {summary.active > 1 && <span className="downloads-count" aria-hidden="true">{summary.active}</span>}
              {(summary.status === 'available' || summary.status === 'ready') &&
                <span className={`downloads-dot${summary.status === 'ready' ? ' ready' : ''}`} aria-hidden="true" />}
            </>
          ) : (
            <>
              <span className="downloads-nav-icon"><SummaryGlyph summary={summary} size={14} /></span>
              <span className="downloads-nav-label">{label}</span>
            </>
          )}
        </button>
  )
  return (
    <>
      {visible && (rail ? button : <div className="downloads-nav-slot">{button}</div>)}
      {visible && open && (
        <DownloadsPopover
          anchorRef={buttonRef}
          placement={rail ? 'right-end' : 'above-start'}
          entries={entries}
          onClose={(refocus) => {
            toggle(false)
            if (refocus) buttonRef.current?.focus()
          }}
          onInstall={() => {
            toggle(false)
            setConfirming(true)
          }}
        />
      )}
      <InstallConfirm open={confirming} version={version ?? ''} onClose={() => setConfirming(false)} />
    </>
  )
}

function DownloadsPopover({ anchorRef, placement, entries, onClose, onInstall }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  placement: FloatingPlacement
  entries: DownloadEntry[]
  onClose: (refocus: boolean) => void
  onInstall: () => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const style = useFloatingPosition({ open: true, anchorRef, contentRef, placement, deps: [entries.length, notesOpen] })

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || contentRef.current?.contains(target)) return
      onClose(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose(true)
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  return (
    <FloatingPortal>
      <div ref={contentRef} className="downloads-popover" role="dialog" aria-label="Downloads" style={style}>
        <DownloadsList
          entries={entries}
          notesOpen={notesOpen}
          onToggleNotes={() => setNotesOpen((value) => !value)}
          onInstall={onInstall}
          onOpen={() => {
            onClose(false)
            openSettingsSection('speech')
          }}
        />
      </div>
    </FloatingPortal>
  )
}

/** The popover's rows: one per download, the update first. */
export function DownloadsList({ entries, notesOpen, onToggleNotes, onInstall, onOpen }: {
  entries: readonly DownloadEntry[]
  notesOpen: boolean
  onToggleNotes: () => void
  onInstall: () => void
  onOpen: () => void
}) {
  if (entries.length === 0) return <p className="downloads-empty">No downloads</p>
  // "Update all": the app's download (its restart stays separate) and every agent Mousse can update.
  const updates = updatableAgents(entries).length + (entries.some((entry) => entry.kind === 'update' && entry.phase === 'available') ? 1 : 0)
  return (
    <>
      <ul className="downloads-list">
        {entries.map((entry) => (
          <DownloadRow key={entry.id} entry={entry} notesOpen={notesOpen} onToggleNotes={onToggleNotes} onInstall={onInstall} onOpen={onOpen} />
        ))}
      </ul>
      {updates > 1 && (
        <div className="downloads-footer">
          {updatableAgents(entries).length > 0 && <span className="downloads-footer-note">Agents update for new runs</span>}
          <button type="button" className="downloads-btn" onClick={() => void downloadsActions.updateAll()}>Update all</button>
        </div>
      )}
    </>
  )
}

const KIND_ICON: Record<DownloadKind, LucideIcon> = { update: ArrowUp, 'dictation-model': Mic, 'voice-model': VolumeHigh, agent: Download }
const KIND_LABEL: Record<DownloadKind, string> = { update: 'App update', 'dictation-model': 'Dictation model', 'voice-model': 'Read-aloud voice', agent: 'Coding agent' }

/** "57 of 136 MB", in KB below a megabyte. */
export function formatDownloadBytes(received: number, total: number): string {
  if (total >= 1_000_000) return `${Math.round(received / 1_000_000)} of ${Math.round(total / 1_000_000)} MB`
  return `${Math.round(received / 1000)} of ${Math.max(1, Math.round(total / 1000))} KB`
}

/** "v1.0.0 → v1.1.0", or the new version alone. */
export function versionChange(entry: Pick<DownloadEntry, 'fromVersion' | 'toVersion'>): string | undefined {
  const to = formatVersion(entry.toVersion)
  if (!to) return undefined
  const from = formatVersion(entry.fromVersion)
  return from ? `${from} → ${to}` : to
}

/**
 * The gist of a failed agent update for its row (the full text is its tooltip): the command's own
 * first line of output, without the "<command> failed (exit 1):" lead-in or npm's prefixes.
 */
export function shortUpdateError(message: string): string {
  const output = message.replace(/^[^\n]*? failed \(exit [^)]*\):\s*/, '')
  const lines = output.split(/\r?\n|(?= npm (?:ERR!|error) )/).map((part) => part.replace(/^\s*npm (?:ERR!|error)\s*/i, '').trim()).filter(Boolean)
  // npm leads with bare fields ("code ECONNRESET"); the sentence after says more.
  const line = lines.find((part) => !/^(code|errno|syscall)\s/.test(part)) ?? lines[0] ?? message
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

/** The row's second line: progress, or the state in a word or two. */
export function downloadDetail(entry: DownloadEntry, notApplied = false): string {
  const updating = entry.operation === 'update'
  switch (entry.phase) {
    case 'downloading': {
      if (updating && entry.percent === undefined) return 'Updating…'
      const percent = `${entry.percent ?? 0}%`
      return entry.totalBytes ? `${percent} · ${formatDownloadBytes(entry.receivedBytes ?? 0, entry.totalBytes)}` : percent
    }
    case 'queued': return 'Waiting'
    case 'verifying': return 'Verifying'
    case 'available': return notApplied ? 'Did not install last time' : versionChange(entry) ?? 'Update available'
    case 'ready': return entry.error ?? (notApplied ? 'Did not install last time' : 'Ready to install')
    case 'installing': return 'Installing…'
    case 'done': return updating ? 'Updated · applies to new runs' : 'Downloaded'
    case 'failed':
      if (updating) return entry.error ? `Update failed: ${shortUpdateError(entry.error)}` : 'Update failed'
      return entry.error ?? 'Download failed'
    case 'cancelled': return 'Cancelled'
  }
}

function IconAction({ label, onClick, accent, children }: { label: string; onClick: () => void; accent?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`downloads-icon-btn${accent ? ' accent' : ''}`} title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  )
}

/** A command to run by hand, with a copy button. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="downloads-command">
      <code title={command}>{command}</code>
      <IconAction label={copied ? 'Copied' : 'Copy command'} onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => undefined)}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </IconAction>
    </div>
  )
}

function DownloadRow({ entry, notesOpen, onToggleNotes, onInstall, onOpen }: {
  entry: DownloadEntry
  notesOpen: boolean
  onToggleNotes: () => void
  onInstall: () => void
  onOpen: () => void
}) {
  const update = entry.kind === 'update'
  const notApplied = useUpdateStore((s) => Boolean(update && s.notAppliedVersion && s.notAppliedVersion === s.availableVersion))
  const notes = useUpdateStore((s) => (update ? s.releaseNotes : undefined))
  const omitted = useUpdateStore((s) => s.omittedReleaseCount)
  const KindIcon = KIND_ICON[entry.kind]
  const offer = entry.offer
  const active = isActiveDownload(entry)
  const bad = entry.phase === 'failed' || (entry.phase === 'ready' && Boolean(entry.error))

  let glyph: ReactNode
  if (active) {
    glyph = (
      <span className="downloads-glyph" role="progressbar" aria-label={`Downloading ${entry.label}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={entry.percent ?? 0}>
        <KindIcon size={15} strokeWidth={1.8} aria-hidden="true" />
      </span>
    )
  } else if (entry.phase === 'done' || (entry.phase === 'ready' && !entry.error)) {
    glyph = <Check size={15} strokeWidth={2.2} className="downloads-ok" aria-hidden="true" />
  } else if (bad) {
    glyph = <CircleAlert size={15} strokeWidth={1.8} className="downloads-bad" aria-hidden="true" />
  } else if (entry.phase === 'installing') {
    glyph = <Loader2 size={15} strokeWidth={1.8} className="spin" aria-hidden="true" />
  } else if (offer) {
    glyph = <ProviderIcon providerId={iconIdOf({ driver: offer.driver, instanceId: offer.instanceId })} size={16} />
  } else {
    glyph = <KindIcon size={15} strokeWidth={1.8} aria-hidden="true" />
  }

  const actions: ReactNode[] = []
  if (update) {
    const hasNotes = Boolean(notes?.some((group) => group.items.length > 0))
    if (hasNotes && entry.phase !== 'installing') {
      actions.push(
        <button key="notes" type="button" className={`downloads-icon-btn${notesOpen ? ' pressed' : ''}`}
          title="What's changed" aria-label="What's changed" aria-expanded={notesOpen} onClick={onToggleNotes}>
          <Info size={14} />
        </button>
      )
    }
    if (entry.phase === 'available') {
      actions.push(<IconAction key="download" label="Download update" accent onClick={() => void updateActions.download()}><Download size={14} /></IconAction>)
    } else if (entry.phase === 'failed') {
      actions.push(<IconAction key="retry" label="Try again" onClick={() => downloadsActions.retry(entry)}><RotateCcw size={14} /></IconAction>)
    } else if (entry.phase === 'ready') {
      actions.push(<button key="restart" type="button" className="downloads-btn" onClick={onInstall}>Restart to update</button>)
    }
  } else if (offer && entry.phase === 'available') {
    if (!offer.manual) actions.push(<IconAction key="update" label={`Update ${entry.label} · applies to new runs`} accent onClick={() => void downloadsActions.updateAgent(entry)}><ArrowUp size={14} /></IconAction>)
  } else if (offer && active) {
    // An agent update runs a package manager to the end; it is not cancelled from here.
  } else if (active) {
    actions.push(<IconAction key="cancel" label="Cancel download" onClick={() => downloadsActions.cancel(entry)}><X size={14} /></IconAction>)
  } else if (entry.phase === 'failed') {
    actions.push(<IconAction key="retry" label="Try again" onClick={() => downloadsActions.retry(entry)}><RotateCcw size={14} /></IconAction>)
    actions.push(<IconAction key="dismiss" label="Dismiss" onClick={() => downloadsActions.dismiss(entry.id)}><X size={14} /></IconAction>)
  } else if (entry.phase === 'done' && !offer) {
    actions.push(<IconAction key="open" label="Open Speech settings" onClick={onOpen}><Settings size={14} /></IconAction>)
  } else if (entry.phase === 'cancelled') {
    actions.push(<IconAction key="again" label="Download again" onClick={() => downloadsActions.retry(entry)}><Download size={14} /></IconAction>)
  }

  return (
    <li className="downloads-row-item">
      <div className="downloads-row" data-phase={entry.phase}>
        <span className="downloads-row-glyph">{glyph}</span>
        <span className="downloads-row-text" title={KIND_LABEL[entry.kind]}>
          <span className="downloads-row-name">{entry.label}</span>
          <span title={bad ? entry.error : undefined} className={`downloads-row-detail${bad ? ' downloads-bad' : ''}`} role={bad ? 'alert' : undefined}>
            {downloadDetail(entry, notApplied)}
          </span>
          {offer?.untested && entry.phase === 'available' && <span className="downloads-row-note">Not yet tested with Mousse</span>}
          {offer?.manual && entry.phase === 'available' && <span className="downloads-row-note">Update manually</span>}
        </span>
        {actions.length > 0 && <span className="downloads-row-actions">{actions}</span>}
      </div>
      {offer?.manual && offer.command && entry.phase === 'available' && <CommandLine command={offer.command} />}
      {update && notesOpen && notes && <ReleaseNotes state={{ releaseNotes: notes, omittedReleaseCount: omitted }} />}
    </li>
  )
}

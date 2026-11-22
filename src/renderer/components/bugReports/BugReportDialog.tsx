import { useEffect, useId, useState } from 'react'
import { diagnosticsSection, finalDraft, type BugReportDiagnostics, type BugReportDraft, type BugReportOutcome } from '../../../shared/bugReports'
import { bugReportsClient } from '../../services/bugReportsClient'
import { useBugReportStore, watchPendingBugReports, type OpenBugReport } from '../../stores/bugReportStore'
import { useAppStore } from '../../stores/appStore'
import { Modal } from '../ui/Modal'
import '../../styles/bugReports.css'

type Phase =
  | { at: 'loading' }
  | { at: 'editing'; draft: BugReportDraft; diagnostics: BugReportDiagnostics }
  | { at: 'sending'; draft: BugReportDraft; diagnostics: BugReportDiagnostics }
  | { at: 'done'; outcome: BugReportOutcome }
  | { at: 'failed'; message: string; draft?: BugReportDraft; diagnostics?: BugReportDiagnostics }

/** The report dialog, one per window: the draft as it will go out, editable, with diagnostics only when ticked. */
export function BugReportDialogHost() {
  const open = useBugReportStore((state) => state.open)
  const profileReady = useAppStore((state) => state.profileReady)
  // Agents' drafts (`report_bug`) wait in the service until a window shows them. They belong to the profile, so the
  // window asks only once it is bound to one.
  useEffect(() => (profileReady ? watchPendingBugReports() : undefined), [profileReady])
  if (!open) return null
  return <BugReportDialog key={open.kind === 'agent' ? open.pending.id : open.key} open={open} />
}

function BugReportDialog({ open }: { open: OpenBugReport }) {
  // The `anonymous` setting's account (a Mousse relay) is not running yet, so with it on the report opens on GitHub
  // for the person to submit from their own account.
  const byBrowser = useBugReportStore((state) => state.settings.anonymous)
  const [phase, setPhase] = useState<Phase>(() => open.kind === 'agent'
    ? { at: 'editing', draft: open.pending.draft, diagnostics: open.pending.diagnostics }
    : { at: 'loading' })
  const [title, setTitle] = useState(open.kind === 'agent' ? open.pending.draft.title : '')
  const [body, setBody] = useState(open.kind === 'agent' ? withoutSignature(open.pending.draft) : '')
  const [include, setInclude] = useState(false)
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    if (open.kind !== 'error') return
    let live = true
    const view = useAppStore.getState().mainView
    bugReportsClient().draft(open.source, { view: typeof view === 'string' ? view : undefined }).then(({ draft, diagnostics }) => {
      if (!live) return
      setTitle(draft.title)
      setBody(withoutSignature(draft))
      setPhase({ at: 'editing', draft, diagnostics })
    }, (error: unknown) => {
      if (live) setPhase({ at: 'failed', message: error instanceof Error ? error.message : 'The draft could not be made.' })
    })
    return () => { live = false }
  }, [open])

  // An agent's draft refreshes its diagnostics once the service has read them.
  const pendingDiagnostics = useBugReportStore((state) => open.kind === 'agent' ? state.pending.find((entry) => entry.id === open.pending.id)?.diagnostics : undefined)
  useEffect(() => {
    if (pendingDiagnostics) setPhase((current) => current.at === 'editing' ? { ...current, diagnostics: pendingDiagnostics } : current)
  }, [pendingDiagnostics])

  // Closing an agent's draft unanswered declines it, so its turn does not wait on a dialog no one sees.
  const close = () => {
    if (phase.at === 'sending') return
    if (open.kind === 'agent' && phase.at !== 'done') { void decline(); return }
    useBugReportStore.getState().close()
  }

  const decline = async () => {
    if (open.kind === 'agent') await bugReportsClient().answer(open.pending.id, null).catch(() => null)
    useBugReportStore.getState().close()
  }

  const send = async () => {
    if (phase.at !== 'editing' || !title.trim()) return
    const { draft, diagnostics } = phase
    const final = finalDraft(draft, { title, body }, include ? diagnostics : undefined)
    setPhase({ at: 'sending', draft, diagnostics })
    try {
      const outcome = open.kind === 'agent'
        ? await bugReportsClient().answer(open.pending.id, final)
        : await bugReportsClient().file(final)
      if (!outcome) { useBugReportStore.getState().close(); return }
      if (open.kind === 'error' && outcome.status !== 'limited') useBugReportStore.getState().markReported(open.key, outcome)
      if (outcome.status === 'browser') window.open(outcome.url, '_blank', 'noopener')
      setPhase({ at: 'done', outcome })
    } catch (error) {
      setPhase({ at: 'failed', message: error instanceof Error ? error.message : 'The report could not be sent.', draft, diagnostics })
    }
  }

  const asker = open.kind === 'agent' ? open.pending.from.name || (open.pending.from.kind === 'bot' ? 'A bot' : 'An agent') : undefined
  const heading = asker ? `${asker} wants to report a bug` : 'Report a bug'

  if (phase.at === 'done') {
    return (
      <Modal open title={heading} hideTitle onClose={close} className="bug-report-overlay"
        footer={<button type="button" className="btn btn-primary" onClick={close}>Done</button>}>
        <OutcomeView outcome={phase.outcome} />
      </Modal>
    )
  }

  const editing = phase.at === 'editing' || phase.at === 'sending'
  const diagnostics = editing ? phase.diagnostics : phase.at === 'failed' ? phase.diagnostics : undefined
  return (
    <Modal open title={heading} onClose={close} closeDisabled={phase.at === 'sending'} className="bug-report-overlay"
      footer={<>
        <span className="bug-report-who" title={byBrowser
          ? 'Opens a prefilled issue on GitHub. You submit it there from your GitHub account, and anyone can see it. Change in Settings → General.'
          : 'Filed straight away from your GitHub account with gh, and anyone can see it. Change in Settings → General.'}>
          {byBrowser ? 'Opens GitHub · filed from your account (public)' : 'Filed from your GitHub account (public)'}
        </span>
        <button type="button" className="btn btn-ghost" disabled={phase.at === 'sending'} onClick={() => void decline()}>{open.kind === 'agent' ? 'Don’t file' : 'Cancel'}</button>
        <button type="button" className="btn btn-primary" disabled={!editing || phase.at === 'sending' || !title.trim()} onClick={() => void send()}>
          {phase.at === 'sending' ? 'Sending…' : byBrowser ? 'Open on GitHub' : 'File on GitHub'}
        </button>
      </>}>
      {phase.at === 'loading' && <p className="bug-report-muted">Preparing the draft…</p>}
      {phase.at === 'failed' && <p role="alert" className="bug-report-error">{phase.message}</p>}
      {editing && <>
        <p className="bug-report-lede">This is exactly what goes to GitHub as a public issue. Nothing else is attached.</p>
        <label className="bug-report-field" htmlFor={titleId}>
          <span>Title</span>
          <input id={titleId} className="bug-report-input" value={title} maxLength={200} disabled={phase.at === 'sending'} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="bug-report-field" htmlFor={bodyId}>
          <span>Details</span>
          <textarea id={bodyId} className="bug-report-input bug-report-body" value={body} rows={9} disabled={phase.at === 'sending'} onChange={(event) => setBody(event.target.value)} />
        </label>
        <label className="bug-report-check">
          <input type="checkbox" checked={include} disabled={phase.at === 'sending'} onChange={(event) => setInclude(event.target.checked)} />
          <span>Include diagnostics</span>
          <span className="bug-report-muted">App and OS version, recent error log lines</span>
        </label>
        {include && diagnostics && <pre className="bug-report-preview" aria-label="Diagnostics that will be added">{diagnosticsSection(diagnostics).replace(/<\/?details>|<\/?summary>/g, '').replace(/^### /m, '')}</pre>}
      </>}
    </Modal>
  )
}

/** The body without its hidden signature line, which is put back when it is sent. */
function withoutSignature(draft: BugReportDraft): string {
  return draft.body.replace(`<!-- ${draft.signature} -->`, '').trimEnd()
}

function OutcomeView({ outcome }: { outcome: BugReportOutcome }) {
  switch (outcome.status) {
    case 'filed':
      return <div className="bug-report-outcome"><strong>Reported · <a href={outcome.url} target="_blank" rel="noopener noreferrer">#{outcome.number}</a></strong><p className="bug-report-muted">Thanks. You can find or revoke it in Settings → General.</p></div>
    case 'existing':
      return <div className="bug-report-outcome"><strong>Added to <a href={outcome.url} target="_blank" rel="noopener noreferrer">#{outcome.number}</a></strong><p className="bug-report-muted">This bug was already reported, so it got a +1 instead of a new issue.</p></div>
    case 'browser':
      return <div className="bug-report-outcome"><strong>Opened on GitHub</strong><p className="bug-report-muted">{outcome.reason}</p><a href={outcome.url} target="_blank" rel="noopener noreferrer">Open it again</a></div>
    case 'limited':
      return <div className="bug-report-outcome"><strong>Not sent</strong><p className="bug-report-muted">{outcome.message}</p></div>
  }
}

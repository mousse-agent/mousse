// The inbox's composer: describe an automation and the Automation manager writes a draft (shown in the pane). While
// composing, Project and Who show under it; Who is the person's pick, never the manager's.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ArrowUp, Loader2 } from '../../../lib/icons'
import { useAppStore } from '../../../stores/appStore'
import { takeAutomationCreate, useAutomationCreate } from '../../../stores/automationCreateStore'
import { Select } from '../../ui/Select'
import { NewBotDialog } from '../../bots/NewBotDialog'
import { NEW_BOT_KEY, whoChoices } from '../DraftCard'
import type { BotChoice } from '../whoDo'
import { sendToManager } from './draftActions'
import { errorText, openDrafts, refreshInbox, useInboxStore } from './inboxStore'

export interface InboxComposerHandle {
  focus(): void
}

const isMac = () => /mac/i.test(globalThis.navigator?.platform ?? '')
export const newKey = () => (isMac() ? '⌘N' : 'Ctrl+N')

/** A bot gives no turn to watch: after this long with no draft, its request stops showing as pending. */
const BOT_WAIT_MS = 90_000

/** Whether the manager is still on the person's last words: its turn has not ended (a bot: no draft yet, for a while). */
export function useManagerWorking(): boolean {
  const composing = useInboxStore((s) => s.composing)
  const working = composing?.status === 'working'
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!working || !composing?.botId) return
    const timer = setTimeout(() => setTick((count) => count + 1), Math.max(0, composing.at + BOT_WAIT_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [working, composing])
  if (!working) return false
  return composing.botId ? Date.now() - composing.at < BOT_WAIT_MS : true
}

export const InboxComposer = forwardRef<InboxComposerHandle, { bots: BotChoice[]; onBotMade: () => void }>(function InboxComposer({ bots, onBotMade }, ref) {
  const projects = useAppStore((s) => s.projects)
  const local = projects.filter((project) => !project.node)
  const activeProjectId = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.projectId)
  const filterProject = useInboxStore((s) => s.filter.project?.projectIds[0])
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [who, setWho] = useState('default')
  const [newBot, setNewBot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const request = useAutomationCreate((state) => state.request)

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), [])

  const fallbackProject = filterProject ?? (local.some((project) => project.id === activeProjectId) ? activeProjectId : undefined) ?? local[0]?.id ?? ''
  const chosenProject = projectId || fallbackProject

  // Repeat this… on a message: the composer opens with its words and project.
  useEffect(() => {
    if (!request) return
    setText(request.prompt?.trim() ?? '')
    if (request.projectId) setProjectId(request.projectId)
    setOpen(true)
    takeAutomationCreate()
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [request])

  // Clicking away folds the chips; the words stay.
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (boxRef.current?.contains(target) || target?.closest?.('[role="listbox"], [role="dialog"], .ui-select-list')) return
      if (!text.trim()) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, text])

  const send = async () => {
    const words = text.trim()
    if (!words || sending) return
    setSending(true)
    setError(null)
    const project = local.find((entry) => entry.id === chosenProject)
    try {
      // Returns once the words are sent; the Drafts pane shows the manager working, then its draft or its error.
      await sendToManager({ text: words, ...(project ? { projectId: project.id, projectName: project.name } : {}), who })
      setText('')
      setOpen(false)
      openDrafts()
      void refreshInbox()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setSending(false)
    }
  }
  const ready = Boolean(text.trim()) && !sending

  return (
    <div className="inbox-composer-box" ref={boxRef} data-open={open || undefined} data-busy={sending || undefined}>
      <div className="inbox-composer" onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); inputRef.current?.focus() } }}>
        <input
          ref={inputRef}
          data-testid="inbox-composer"
          placeholder="Describe an automation…"
          aria-label="Describe an automation"
          title={`New automation · ${newKey()} · ? for shortcuts`}
          value={text}
          readOnly={sending}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setText(event.target.value); if (error) setError(null) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
            if (event.key === 'Escape') { setOpen(false); event.currentTarget.blur() }
          }}
        />
        <button
          type="button"
          className="inbox-composer-send"
          data-testid="inbox-composer-send"
          aria-label={sending ? 'Sending' : 'Create automation'}
          aria-busy={sending || undefined}
          title={sending ? 'Sending…' : text.trim() ? 'Create · Enter' : 'Describe it first'}
          disabled={!ready}
          onClick={() => void send()}
        >
          {sending ? <Loader2 size={14} strokeWidth={2} className="inbox-spin" aria-hidden="true" /> : <ArrowUp size={14} strokeWidth={2.2} aria-hidden="true" />}
        </button>
      </div>
      {open ? (
        <div className="inbox-composer-chips" data-testid="inbox-composer-chips">
          <span className="inbox-draft-field" title="Project">
            <Select ariaLabel="Project" size="small" value={chosenProject} placeholder="Pick a project" disabled={sending} options={local.map((project) => ({ value: project.id, label: project.name }))} onChange={setProjectId} />
          </span>
          <span className="inbox-draft-field" title="Who does it">
            <Select ariaLabel="Who" size="small" value={who} disabled={sending} options={whoChoices(bots)} onChange={(key) => { if (key === NEW_BOT_KEY) setNewBot(true); else setWho(key) }} />
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="inbox-composer-error" role="alert" data-testid="inbox-composer-error">
          <span title={error}>{error}</span>
          <button type="button" className="inbox-text-btn" onClick={() => void send()}>Retry</button>
        </div>
      ) : null}
      {newBot ? (
        <NewBotDialog
          initialDescription={text}
          onCreated={(bot) => { setNewBot(false); setWho(`bot:${bot.id}`); onBotMade() }}
          onClose={() => setNewBot(false)}
        />
      ) : null}
    </div>
  )
})

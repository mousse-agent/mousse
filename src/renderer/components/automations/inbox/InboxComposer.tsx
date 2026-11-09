// The inbox's composer: describe an automation and the Automation manager writes a draft (shown in the pane). While
// composing, Project and Who show under it; Who is the person's pick, never the manager's.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { isThreadActivityActive } from '../../../../shared/types'
import { Folder, Sparkles, User } from '../../../lib/icons'
import { useAppStore } from '../../../stores/appStore'
import { takeAutomationCreate, useAutomationCreate } from '../../../stores/automationCreateStore'
import { Select } from '../../ui/Select'
import { NewBotDialog } from '../../bots/NewBotDialog'
import { NEW_BOT_KEY, whoChoices } from '../DraftCard'
import type { BotChoice } from '../whoDo'
import { sendToManager } from './draftActions'
import { openDrafts, refreshInbox, useInboxStore } from './inboxStore'

export interface InboxComposerHandle {
  focus(): void
}

const isMac = () => /mac/i.test(globalThis.navigator?.platform ?? '')
export const newKey = () => (isMac() ? '⌘N' : 'Ctrl+N')

/** Whether the manager is still on it: its turn is running, or the words went out a moment ago. */
export function useManagerWorking(): boolean {
  const composing = useInboxStore((s) => s.composing)
  const activity = useAppStore((s) => (composing?.threadId ? s.threadActivity[composing.threadId] : undefined))
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!composing) return
    const timer = setInterval(() => setTick((count) => count + 1), 2_000)
    return () => clearInterval(timer)
  }, [composing])
  if (!composing) return false
  return composing.threadId ? isThreadActivityActive(activity) || Date.now() - composing.at < 4_000 : Date.now() - composing.at < 90_000
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
      await sendToManager({ text: words, ...(project ? { projectId: project.id, projectName: project.name } : {}), who })
      setText('')
      setOpen(false)
      openDrafts()
      void refreshInbox()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="inbox-composer-box" ref={boxRef} data-open={open || undefined}>
      <label className="inbox-composer" title={`New automation · ${newKey()}`}>
        <Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
        <input
          ref={inputRef}
          data-testid="inbox-composer"
          placeholder="Describe an automation…"
          aria-label="Describe an automation"
          value={text}
          disabled={sending}
          onFocus={() => setOpen(true)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
            if (event.key === 'Escape') { setOpen(false); event.currentTarget.blur() }
          }}
        />
      </label>
      {open ? (
        <div className="inbox-composer-chips" data-testid="inbox-composer-chips">
          <span className="inbox-draft-field" title="Project">
            <Folder size={13} strokeWidth={1.8} aria-hidden="true" />
            <Select ariaLabel="Project" size="small" value={chosenProject} placeholder="Pick a project" options={local.map((project) => ({ value: project.id, label: project.name }))} onChange={setProjectId} />
          </span>
          <span className="inbox-draft-field" title="Who does it">
            <User size={13} strokeWidth={1.8} aria-hidden="true" />
            <Select ariaLabel="Who" size="small" value={who} options={whoChoices(bots)} onChange={(key) => { if (key === NEW_BOT_KEY) setNewBot(true); else setWho(key) }} />
          </span>
          <span className="inbox-strip-spacer" />
          <span className="inbox-composer-hint">Enter</span>
        </div>
      ) : null}
      {error ? <p className="inbox-draft-problem" role="alert">{error}</p> : null}
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

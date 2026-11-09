import { useEffect, useRef, useState } from 'react'
import { Select, type SelectOption } from '../ui/Select'
import { computerOptions, projectsOn, type ComputerChoice } from './computerChoice'
import type { BotChoice } from './whoDo'
import type { Project } from '../../../shared/types'

/** The built-in manager's key in the Built by chip; a bot's is `bot:<id>`. */
export const MANAGER_KEY = 'manager'

/** Who builds it: your first bot, else the Automation manager. Built by always offers the manager too. */
export function builtByOptions(bots: readonly BotChoice[]): SelectOption[] {
  return [...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })), { value: MANAGER_KEY, label: 'Automation manager' }]
}

export function defaultBuiltBy(bots: readonly BotChoice[]): string {
  return bots[0] ? `bot:${bots[0].id}` : MANAGER_KEY
}

export interface ComposerSend {
  text: string
  projectId: string
  /** Another computer's Net node; '' for this one. */
  node: string
  builtBy: string
}

/**
 * The page's first element: describe an automation in words and the manager (the Automation manager or a bot) builds
 * a draft. Project is prefilled and required (the manager asks when it is missing); Computer shows with two or more.
 * While the manager works, one line says so, with Stop.
 */
export function AutomationComposer({ projects, computers, bots, initialProjectId, prefill, working, onSend, onStop, onSetUpByHand, onOpenConversation }: {
  projects: readonly Project[]
  computers: ComputerChoice[]
  bots: BotChoice[]
  initialProjectId: string
  /** Text and project from Automate… or Repeat this…; a new nonce fills the composer again. */
  prefill?: { nonce: number; text: string; projectId?: string } | null
  working: boolean
  onSend: (send: ComposerSend) => Promise<void>
  onStop: () => void
  onSetUpByHand: (projectId: string) => void
  onOpenConversation?: () => void
}) {
  const [text, setText] = useState('')
  const [projectId, setProjectId] = useState(initialProjectId)
  const [node, setNode] = useState('')
  const [builtBy, setBuiltBy] = useState(() => defaultBuiltBy(bots))
  const [chose, setChose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // The bots arrive after the page opens: the first one builds it unless the person picked.
  useEffect(() => { if (!chose) setBuiltBy(defaultBuiltBy(bots)) }, [bots, chose])
  useEffect(() => { if (!projectId && initialProjectId) setProjectId(initialProjectId) }, [initialProjectId, projectId])
  useEffect(() => {
    if (!prefill) return
    setText(prefill.text)
    if (prefill.projectId !== undefined) setProjectId(prefill.projectId)
    requestAnimationFrame(() => input.current?.focus())
  }, [prefill])

  const many = computers.length > 1
  const shownProjects = many ? projectsOn(projects, node) : projects
  const projectOptions: SelectOption[] = [
    { value: '', label: 'No project' },
    ...shownProjects.map((project) => ({ value: project.id, label: project.name }))
  ]
  const ready = text.trim() !== '' && !busy

  const send = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await onSend({ text: text.trim(), projectId, node, builtBy })
      setText('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="automation-composer-wrap">
      <div className="automation-composer" data-testid="automation-composer">
        <textarea
          ref={input}
          className="automation-composer-input"
          aria-label="Describe an automation"
          placeholder="Describe an automation…"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="automation-create-chips">
          <span data-testid="automation-project">
            <Select ariaLabel="Project" className="automation-chip-select" size="small" value={projectId} options={projectOptions} title="Where it runs" onChange={setProjectId} />
          </span>
          {many ? (
            <span data-testid="automation-composer-computer">
              <Select ariaLabel="Computer" className="automation-chip-select" size="small" value={node} options={computerOptions(computers)} title="The computer that runs it" onChange={(next) => { setNode(next); setProjectId('') }} />
            </span>
          ) : null}
          <span className="automation-composer-by">Built by</span>
          <span data-testid="automation-built-by">
            <Select ariaLabel="Built by" className="automation-chip-select" size="small" value={builtBy} options={builtByOptions(bots)} title="Who turns your words into a draft" onChange={(value) => { setChose(true); setBuiltBy(value) }} />
          </span>
          <span className="automation-create-spacer" />
          <button type="button" className="settings-btn primary" data-testid="automation-composer-send" disabled={!ready} title="Send (Enter)" onClick={() => void send()}>Send</button>
        </div>
      </div>
      {working ? (
        <p className="automation-composer-status" data-testid="automation-composer-status" role="status">
          <span>Setting it up…</span>
          <button type="button" className="scheduled-link-btn" data-testid="automation-composer-stop" onClick={onStop}>Stop</button>
          {onOpenConversation ? <button type="button" className="scheduled-link-btn" onClick={onOpenConversation}>Open conversation</button> : null}
        </p>
      ) : null}
      {error ? <p className="scheduled-action-error" role="alert">{error}</p> : null}
      <button type="button" className="scheduled-link-btn automation-by-hand" data-testid="automation-set-up-by-hand" title="A blank draft, set up in the full form" onClick={() => onSetUpByHand(projectId)}>Set up by hand</button>
    </div>
  )
}

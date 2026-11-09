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

/** The Who chip's value for "+ New bot…": it opens the New bot dialog instead of being chosen. */
export const NEW_BOT_KEY = '__new_bot__'

/** Who does it: the default agent, one of your bots, or a new bot. The person picks it; the manager never does. */
export function whoChoices(bots: readonly BotChoice[]): SelectOption[] {
  return [
    { value: 'default', label: 'Default agent' },
    ...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })),
    { value: NEW_BOT_KEY, label: <span data-testid="automation-new-bot">+ New bot…</span>, textValue: '+ New bot…' }
  ]
}

/** One Use-case starter: a sentence for the composer. Starters never pick Who. */
export const STARTERS: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'Review PRs', text: 'Every weekday at 9, review open pull requests and comment on risky changes.' },
  { label: 'Morning brief', text: 'Every morning at 8, sum up what changed in the project yesterday.' },
  { label: 'Triage issues', text: 'Every day at 10, triage new issues: label them and flag the urgent ones.' },
  { label: 'Watch CI', text: 'When checks fail on my pull request, find the cause and suggest a fix.' }
]

export interface ComposerSend {
  text: string
  projectId: string
  /** Another computer's Net node; '' for this one. */
  node: string
  builtBy: string
  /** Who does it: `default` or `bot:<id>`. */
  who: string
}

/**
 * The page's first element: describe an automation in words and the manager (the Automation manager or a bot) builds
 * a draft. Project is prefilled and required (the manager asks when it is missing); Computer shows with two or more.
 * While the manager works, one line says so, with Stop.
 */
export function AutomationComposer({ projects, computers, bots, initialProjectId, prefill, working, who, onWho, starters, onSend, onStop, onSetUpByHand, onOpenConversation }: {
  projects: readonly Project[]
  computers: ComputerChoice[]
  bots: BotChoice[]
  initialProjectId: string
  /** Text and project from Automate… or Repeat this…; a new nonce fills the composer again. */
  prefill?: { nonce: number; text: string; projectId?: string } | null
  working: boolean
  /** Who does it (`default`, `bot:<id>`); `NEW_BOT_KEY` asks for a new bot. */
  who: string
  onWho: (key: string, text: string) => void
  /** Use-case starters, when the page is empty. */
  starters?: boolean
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
      await onSend({ text: text.trim(), projectId, node, builtBy, who })
      setText('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="automation-composer-wrap">
      {starters ? (
        <div className="automation-starters" data-testid="automation-starters" aria-label="Ideas">
          {STARTERS.map((starter) => (
            <button key={starter.label} type="button" className="automation-chip" title={starter.text} onClick={() => { setText(starter.text); requestAnimationFrame(() => input.current?.focus()) }}>{starter.label}</button>
          ))}
        </div>
      ) : null}
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
          <span data-testid="automation-who">
            <Select ariaLabel="Who" className="automation-chip-select" size="small" value={who} options={whoChoices(bots)} title="Who does it" onChange={(key) => onWho(key, text)} />
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

import { forwardRef, useEffect, useState, type FocusEvent, type ReactNode } from 'react'
import { Plus } from '../../lib/icons'
import { Select, type SelectOption } from '../ui/Select'
import { createInputOf, quickDraft, scheduleOf, validateDraft, type JobDraft, type ScheduledCatalog } from './jobDraft'
import { describeScheduleLong, errorText, firstRunOf, relativeWhen, SCHEDULE_PRESETS, type SchedulePreset } from './scheduledLabels'
import type { CreateScheduledJobInput } from '../../../shared/types'

type Preset = Exclude<SchedulePreset, 'custom'>

/**
 * The quick-add line at the top of the page: type what the agent should do, pick when (or nothing, for the editor's
 * default of every 30 minutes) and where, press Enter. Custom… opens the full editor with what was typed.
 * A task in a Git project runs in a new worktree per run; elsewhere in the project checkout.
 */
export const QuickAdd = forwardRef<HTMLInputElement, {
  catalog: ScheduledCatalog
  /** Whether a project is a Git repository; undefined until known. */
  isGitRepo: (projectId: string) => Promise<boolean>
  create: (input: CreateScheduledJobInput) => Promise<void>
  openCustom: (draft: JobDraft) => void
  /** The page's "…" menu, beside the field. */
  menu?: ReactNode
  /** The full editor is open with what was typed: the line stays collapsed and keeps its text for Cancel. */
  editing?: boolean
  /** Changes when the full editor added the task: the typed text is used up. */
  cleared?: number
}>(function QuickAdd({ catalog, isGitRepo, create, openCustom, menu, editing = false, cleared = 0 }, inputRef) {
  const [text, setText] = useState('')
  const [preset, setPreset] = useState<Preset | null>(null)
  const [projectId, setProjectId] = useState('')
  const [repo, setRepo] = useState<Record<string, boolean>>({})
  const [focused, setFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const expanded = !editing && (focused || text.trim() !== '')

  useEffect(() => {
    if (cleared === 0) return
    setText('')
    setPreset(null)
  }, [cleared])

  const knowRepo = async (id: string): Promise<boolean> => {
    if (!id) return false
    if (id in repo) return repo[id]
    let answer = false
    try {
      answer = await isGitRepo(id)
    } catch {
      // Not known: the checkout, as the editor would default to.
    }
    setRepo((current) => ({ ...current, [id]: answer }))
    return answer
  }

  const chooseProject = (id: string) => {
    setProjectId(id)
    void knowRepo(id)
  }

  const draftNow = (gitRepo: boolean) => quickDraft(text.trim(), preset, projectId, gitRepo)

  const add = async () => {
    if (busy || !text.trim()) return
    setBusy(true)
    setError(null)
    try {
      const draft = draftNow(await knowRepo(projectId))
      const problems = validateDraft(draft, { hasWebhook: false, requireName: false })
      const first = Object.values(problems)[0]
      if (first) {
        setError(first)
        return
      }
      await create(createInputOf(draft, catalog))
      setText('')
      setPreset(null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const custom = async () => {
    const draft = draftNow(await knowRepo(projectId))
    setError(null)
    setFocused(false)
    openCustom(draft)
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    // A Select's list sits in a portal; picking from it keeps the line open.
    if (next instanceof Element && next.closest('[role="listbox"]')) return
    setFocused(false)
  }

  const projectOptions: SelectOption[] = [
    { value: '', label: 'No project' },
    ...catalog.projects.map((project) => ({ value: project.id, label: project.name }))
  ]

  const schedule = scheduleOf(draftNow(Boolean(repo[projectId])))
  const first = firstRunOf(schedule)
  const where = !projectId
    ? 'Runs in a new thread'
    : !(projectId in repo)
      ? null
      : repo[projectId]
        ? 'Runs in a new worktree'
        : 'Runs in the project checkout'
  const preview = [
    describeScheduleLong(schedule).replace(/, this computer's time$/, ''),
    first ? `First run ${relativeWhen(first.toISOString())}` : null,
    where ? `${where}, on your default model` : null
  ].filter(Boolean).join(' · ')

  return (
    <div className="scheduled-quick" onFocus={() => setFocused(true)} onBlur={onBlur}>
      <div className="scheduled-quick-top">
        <div className="scheduled-quick-field">
          <Plus size={14} aria-hidden="true" className="scheduled-quick-lead" />
          <input
            ref={inputRef}
            className="scheduled-quick-input"
            aria-label="New task"
            placeholder="What should the agent do?"
            value={text}
            onChange={(event) => { setText(event.target.value); setError(null) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void add()
              } else if (event.key === 'Escape' && text) {
                event.preventDefault()
                setText('')
              }
            }}
          />
        </div>
        {menu}
      </div>
      {expanded ? (
        <>
          <div className="scheduled-quick-row">
            <div className="scheduled-chips" role="group" aria-label="When">
              {SCHEDULE_PRESETS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className="scheduled-chip"
                  aria-pressed={preset === item.value}
                  onClick={() => setPreset((current) => (current === item.value ? null : item.value))}
                >
                  {item.label}
                </button>
              ))}
              <button type="button" className="scheduled-chip" onClick={() => void custom()}>Custom…</button>
            </div>
            <span className="scheduled-when-gap" />
            <Select className="scheduled-select where" ariaLabel="Project" value={projectId} options={projectOptions} onChange={chooseProject} />
            <button type="button" className="settings-btn scheduled-add" disabled={busy || !text.trim()} onClick={() => void add()}>
              Add <kbd aria-hidden="true">↵</kbd>
            </button>
          </div>
          <p className="scheduled-quick-hint" data-testid="quick-preview">{preview}</p>
        </>
      ) : null}
      {error ? <p className="scheduled-field-error" role="alert">{error}</p> : null}
    </div>
  )
})

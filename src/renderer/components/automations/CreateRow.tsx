import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from '../../lib/icons'
import { describePermissionMode, isStricter, PERMISSION_MODES, type PermissionMode } from '../../../shared/permissionMode'
import { isWorkflowPrompt } from '../../../shared/jobPermissionEdit'
import type { CreateScheduledJobInput, JobSchedule } from '../../../shared/types'
import { Select, type SelectOption } from '../ui/Select'
import { errorText, firstRunOf, nameFromPrompt, SCHEDULE_PRESETS } from '../scheduled/scheduledLabels'
import type { ScheduledCatalog } from '../scheduled/jobDraft'
import { parseWhen } from './parseWhen'
import { nextBeforeAdd } from './automationTime'
import { describeSchedule } from '../../../shared/scheduleLabel'

/** A When the person picked from the chip; it wins over what the text says. */
type Picked = { key: string; schedule: JobSchedule; label: string }

const PICKS: Picked[] = [
  ...SCHEDULE_PRESETS.map((preset) => ({ key: preset.value, schedule: preset.schedule as JobSchedule, label: preset.label })),
  // On demand exists only when picked: text never makes one.
  { key: 'manual', schedule: { kind: 'manual' }, label: 'On demand' }
]

export interface CreateRowProps {
  catalog: ScheduledCatalog
  /** The default agent's name, for the Who chip (pickers come later). */
  whoName: string
  /** The computer that will own it. */
  owner: { name: string; timeZone: string }
  /** The project the page opens with. */
  initialProjectId: string
  /** The May a new automation gets (the profile's default mode, held to its ceiling). */
  defaultMay: PermissionMode
  /** The most it may have: the mode the person holds. */
  ceiling: PermissionMode
  isGitRepo: (projectId: string) => Promise<boolean>
  create: (input: CreateScheduledJobInput) => Promise<void>
  /** Bumped by ⌘N on the page: the row opens and takes focus. */
  openRequest: number
  /** The quiet row's tooltip, with its shortcut. */
  title: string
}

/**
 * The quiet "+ New automation…" row. It opens in place: one line of what to do and when ("every weekday at 9 review
 * open PRs"), the When · Who · Where chips, and a line that says what Add authorizes: the next run on the owning
 * computer's clock and the effective May. An unread When says Choose when and keeps Add off.
 */
export function CreateRow({ catalog, whoName, owner, initialProjectId, defaultMay, ceiling, isGitRepo, create, openRequest, title }: CreateRowProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<Picked | null>(null)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [may, setMay] = useState<PermissionMode>(defaultMay)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repo, setRepo] = useState<Record<string, boolean>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setMay(defaultMay) }, [defaultMay])
  useEffect(() => { if (!open) setProjectId(initialProjectId) }, [initialProjectId, open])
  useEffect(() => {
    if (openRequest === 0) return
    setOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [openRequest])
  useEffect(() => {
    if (!projectId || projectId in repo) return
    let live = true
    isGitRepo(projectId).then((answer) => { if (live) setRepo((current) => ({ ...current, [projectId]: answer })) }, () => { if (live) setRepo((current) => ({ ...current, [projectId]: false })) })
    return () => { live = false }
  }, [projectId, repo, isGitRepo])

  const now = new Date()
  const parsed = useMemo(() => parseWhen(text, new Date()), [text])
  const when: Pick<Picked, 'schedule' | 'label'> | null = picked ?? (parsed.kind === 'ok' ? { schedule: parsed.schedule, label: parsed.label } : null)
  const prompt = (picked || parsed.kind !== 'ok' ? text : parsed.prompt).trim()
  const workflow = isWorkflowPrompt(prompt)
  const first = when ? firstRunOf(when.schedule, now) : null
  const canAdd = Boolean(when && prompt && !busy)
  const whenTitle = !when && parsed.kind === 'ambiguous' ? parsed.reason : !when ? 'Say when in the text, like "every weekday at 9", or pick one' : when.label

  const close = () => {
    setOpen(false)
    setError(null)
  }

  const add = async () => {
    if (!when || !prompt) return
    setBusy(true)
    setError(null)
    try {
      const gitProject = projectId ? (repo[projectId] ?? await isGitRepo(projectId).catch(() => false)) : false
      await create({
        name: nameFromPrompt(prompt) || 'Automation',
        prompt,
        schedule: when.schedule,
        createThread: true,
        ...(projectId ? { projectId } : {}),
        ...(projectId && gitProject ? { workspace: { kind: 'newWorktree' as const } } : {}),
        ...(!workflow ? { permissionMode: may } : {}),
        tellMe: 'news'
      })
      setText('')
      setPicked(null)
      setOpen(false)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="automation-create-quiet"
        data-testid="automation-create"
        title={title}
        onClick={() => { setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()) }}
      >
        <Plus size={14} aria-hidden="true" /> New automation…
      </button>
    )
  }

  const projectOptions: SelectOption[] = [
    { value: '', label: 'No project' },
    ...catalog.projects.map((project) => ({ value: project.id, label: project.name }))
  ]
  const mayOptions: SelectOption<PermissionMode>[] = PERMISSION_MODES.map((mode) => ({ value: mode, label: describePermissionMode(mode), disabled: isStricter(ceiling, mode) }))

  return (
    <div
      className="automation-create"
      data-testid="automation-create"
      data-open="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
    >
      <input
        ref={inputRef}
        className="automation-create-input"
        data-testid="automation-create-input"
        aria-label="New automation"
        placeholder="every weekday at 9 review open PRs"
        value={text}
        onChange={(event) => { setText(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            if (canAdd) void add()
          }
        }}
      />
      <div className="automation-create-chips">
        <Select
          ariaLabel="When"
          className={`automation-chip-select when${when ? '' : ' unresolved'}`}
          size="small"
          title={whenTitle}
          value={picked?.key ?? 'text'}
          options={[
            { value: 'text', label: parsed.kind === 'ok' ? parsed.label : 'Choose when', disabled: parsed.kind !== 'ok' },
            ...PICKS.map((pick) => ({ value: pick.key, label: pick.label }))
          ]}
          renderValue={() => <span data-testid="automation-create-when">{when ? when.label : 'Choose when'}</span>}
          onChange={(key) => setPicked(PICKS.find((pick) => pick.key === key) ?? null)}
        />
        <span className="automation-chip readonly" title={workflow ? 'A workflow runs itself' : 'Your default agent'} data-testid="automation-create-who">
          {workflow ? prompt.split(/\s+/)[0] : whoName}
        </span>
        <Select
          ariaLabel="Where"
          className="automation-chip-select"
          size="small"
          value={projectId}
          options={projectOptions}
          onChange={setProjectId}
        />
        {picked ? <button type="button" className="scheduled-link-btn" onClick={() => setPicked(null)} title="Read When from the text again">Use text</button> : null}
      </div>
      <div className="automation-create-line">
        <span data-testid="automation-create-next">
          {when
            ? when.schedule.kind === 'manual'
              ? 'Runs when you run it'
              : first ? `Next ${nextBeforeAdd(first.toISOString(), now, owner)}` : `${describeSchedule(when.schedule, now)}`
            : 'Choose when'}
        </span>
        {!workflow ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="automation-create-may">
              May:
              <Select<PermissionMode>
                ariaLabel="May"
                className="automation-inline-select"
                size="small"
                value={may}
                options={mayOptions}
                title="What a run may do without asking. Your default mode for new threads, never more than you hold."
                onChange={setMay}
              />
            </span>
          </>
        ) : null}
        <span className="automation-create-spacer" />
        <button type="button" className="settings-btn" onClick={close}>Cancel</button>
        <button type="button" className="settings-btn primary" data-testid="automation-create-add" disabled={!canAdd} onClick={() => void add()} title="Add (Enter)">
          Add ⏎
        </button>
      </div>
      {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
    </div>
  )
}

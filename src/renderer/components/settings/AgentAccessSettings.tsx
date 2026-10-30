import { useId, type KeyboardEvent } from 'react'
import {
  normalizeAgentAccessSettings,
  type AgentAccessLevel,
  type MousseSettings,
  type MousseSettingsUpdate
} from '../../../shared/settings'
import type { Project } from '../../../shared/types'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { Select } from '../ui/Select'
import { Check, ShieldCheck } from '../../lib/icons'
import { useComputers } from '../../lib/computers'

/** What each level lets an agent do, in the words the screen uses (SPEC §15.1). */
export const AGENT_ACCESS_LEVELS: ReadonlyArray<{ value: AgentAccessLevel; label: string; summary: string }> = [
  {
    value: 'lineage',
    label: 'Lineage only',
    summary: 'An agent works on its own thread and the subagents it starts. It cannot see or change any other thread.'
  },
  {
    value: 'read',
    label: 'Read',
    summary: 'An agent can also list and search other threads and see what they ran. It cannot read their messages or change them.'
  },
  {
    value: 'manage',
    label: 'Manage',
    summary: 'An agent can also read the full events and messages of other threads. Tools that change other threads will need this level.'
  }
]

/** Threads whose level stays lower than the setting, whatever it says (SPEC §15.1, static ceiling). */
export const CAPPED_THREADS: ReadonlyArray<{ id: string; label: string; cap: string }> = [
  { id: 'remote', label: 'Threads driven by a remote send, such as from a linked phone', cap: 'Lineage only' },
  { id: 'bots', label: 'Bot threads', cap: 'Lineage only' },
  { id: 'plan', label: 'Turns in Plan mode, and read-only subagents', cap: 'Read at most' }
]

const ROW_SELECTOR = '[role="checkbox"]'

/** Arrow keys, Home and End move between the project rows; Tab leaves the list as usual. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: 0, End: 0 }
  if (!(event.key in keys)) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR))
  if (rows.length === 0) return
  const at = rows.indexOf(document.activeElement as HTMLElement)
  let next: number
  if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = rows.length - 1
  else next = Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + keys[event.key]))
  event.preventDefault()
  rows[next].focus()
}

/**
 * Settings > Agents > Agent access: how far an agent may reach beyond its own thread and its
 * subagents, and in which projects. The stored project list is empty for "every project", so the
 * screen names that choice outright and never lets a limited list become empty by unchecking its
 * last project, which the daemon would read as every project.
 */
export function AgentAccessSettings({
  settings,
  projects,
  updateSettings
}: {
  settings: MousseSettings
  projects: readonly Project[]
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
}) {
  const access = normalizeAgentAccessSettings(settings.agentAccess)
  const level = AGENT_ACCESS_LEVELS.find((entry) => entry.value === access.level) ?? AGENT_ACCESS_LEVELS[0]
  const projectsId = useId()
  const computersId = useId()
  const { routed, byNode } = useComputers()
  const computers = Object.values(byNode).sort((a, b) => a.name.localeCompare(b.name))
  // Allowed computers that are no longer the user's stay visible so the person can remove them.
  const goneComputers = access.computers.filter((node) => !byNode[node])
  const toggleComputer = (node: string) =>
    save({ computers: access.computers.includes(node) ? access.computers.filter((entry) => entry !== node) : [...access.computers, node] })

  // Always the whole setting: a partial write must not drop the project list or the approvals switch.
  const save = (next: Partial<typeof access>) => void updateSettings({ agentAccess: { ...access, ...next } })

  const everyProject = access.projectIds.length === 0
  const known = new Set(projects.map((project) => project.id))
  // Listed projects that no longer exist stay visible so the person can remove them.
  const removed = access.projectIds.filter((id) => !known.has(id))

  const toggleProject = (id: string) => {
    if (everyProject) return save({ projectIds: [id] })
    if (!access.projectIds.includes(id)) return save({ projectIds: [...access.projectIds, id] })
    // The last project stays: an empty list would widen the limit to every project.
    if (access.projectIds.length === 1) return
    save({ projectIds: access.projectIds.filter((entry) => entry !== id) })
  }

  const projectRow = (id: string, label: string, checked: boolean, onClick: () => void, locked = false) => (
    <button
      key={id}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={locked || undefined}
      className={`agent-access-row${checked ? ' on' : ''}`}
      onClick={onClick}
    >
      <span className="agent-access-check" aria-hidden="true">{checked && <Check size={14} strokeWidth={2} />}</span>
      <span className="agent-access-label">{label}</span>
    </button>
  )

  return (
    <SettingsGroup title="Agent access" icon={ShieldCheck}>
      <SettingsRow
        title="Reach beyond their own threads"
        titleId="agent-access-level-title"
        description={<>
          <span id="agent-access-level-summary">{level.summary}</span>
          <br />
          Lowering this applies to agents that are already running; raising it applies from their next turn.
        </>}
        control={
          <Select
            ariaLabel="Agent access level"
            value={access.level}
            // Answering approvals is part of Manage: leaving it switches the answer switch off, so raising the level
            // again later never brings the permission back on its own.
            onChange={(next) => save({ level: next, ...(next !== 'manage' ? { answerApprovals: false } : {}) })}
            options={AGENT_ACCESS_LEVELS.map(({ value, label, summary }) => ({ value, label, description: summary }))}
          />
        }
      />
      {access.level !== 'lineage' && (
        <SettingsRow
          title="Projects"
          titleId={projectsId}
          description={everyProject
            ? 'Agents can reach threads in every project, including threads without a project.'
            : 'Agents can reach only threads in the checked projects. New projects are not added. Keep at least one checked, or choose All projects.'}
        >
          <div
            role="group"
            aria-labelledby={projectsId}
            className="agent-access-projects"
            onKeyDown={moveFocus}
          >
            {projectRow('all-projects', 'All projects', everyProject, () => { if (!everyProject) save({ projectIds: [] }) })}
            {projects.map((project) =>
              projectRow(
                project.id,
                project.name,
                access.projectIds.includes(project.id),
                () => toggleProject(project.id),
                !everyProject && access.projectIds.length === 1 && access.projectIds[0] === project.id
              )
            )}
            {removed.map((id) =>
              projectRow(
                id,
                'Removed project',
                true,
                () => toggleProject(id),
                access.projectIds.length === 1
              )
            )}
          </div>
        </SettingsRow>
      )}
      {access.level === 'manage' && (
        <SettingsRow
          title="Agents may answer approvals on other threads"
          htmlFor="agent-access-answer-approvals"
          description={<>
            <strong>Use with care.</strong> An agent can approve a command, a file change or a tool that
            another thread asked to run, in the projects above, without you seeing the request first. It can approve only what its own permission
            mode would allow without asking, never &ldquo;Always for this thread&rdquo;, and never its own thread. Each answer shows in that
            thread as approved by an agent. Requests the provider asks for itself (such as Claude Code&rsquo;s own safety check) and turns you
            started yourself stay yours. Off by default, and switched off again when the level above is lowered.
          </>}
          control={
            <Switch
              id="agent-access-answer-approvals"
              label="Agents may answer approvals on other threads"
              checked={access.answerApprovals}
              onChange={(answerApprovals) => save({ answerApprovals })}
            />
          }
        />
      )}
      {(routed && computers.length > 0) || goneComputers.length > 0 ? (
        <SettingsRow
          title="Subagents on other computers"
          titleId={computersId}
          description="An agent can start a subagent on a checked computer. It runs there under that computer's agents and accounts, in its copy of the repository, at no more than Auto-accept edits and the limit that computer set for this one. None are checked at first."
        >
          <div role="group" aria-labelledby={computersId} className="agent-access-projects" onKeyDown={moveFocus}>
            {computers.map((computer) =>
              projectRow(computer.node, computer.online ? computer.name : `${computer.name} (offline)`, access.computers.includes(computer.node), () => toggleComputer(computer.node))
            )}
            {goneComputers.map((node) => projectRow(node, 'Removed computer', true, () => toggleComputer(node)))}
          </div>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title="Capped threads"
        description="These keep a lower level whatever you choose above."
      >
        <ul className="agent-access-caps" aria-label="Capped threads">
          {CAPPED_THREADS.map((entry) => (
            <li key={entry.id} className="agent-access-cap">
              <span>{entry.label}</span>
              <span className="agent-access-cap-level">{entry.cap}</span>
            </li>
          ))}
        </ul>
      </SettingsRow>
    </SettingsGroup>
  )
}

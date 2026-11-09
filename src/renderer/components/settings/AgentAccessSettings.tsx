import {
  normalizeAgentAccessSettings,
  type AgentAccessLevel,
  type MousseSettings,
  type MousseSettingsUpdate
} from '../../../shared/settings'
import type { Project } from '../../../shared/types'
import { MoreDetails, SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { Select } from '../ui/Select'
import { ShieldCheck } from '../../lib/icons'
import { useComputers } from '../../lib/computers'
import { AgentAutomationsSettings } from './AgentAutomationsSettings'

/** What each level lets an agent do, in the words the screen uses (SPEC §15.1). */
export const AGENT_ACCESS_LEVELS: ReadonlyArray<{ value: AgentAccessLevel; label: string; summary: string }> = [
  {
    value: 'lineage',
    label: 'Lineage only',
    summary: 'Agents see only their own thread and the subagents they start.'
  },
  {
    value: 'read',
    label: 'Read',
    summary: 'Agents can also list and search other threads and see what they ran, but not read their messages.'
  },
  {
    value: 'manage',
    label: 'Manage',
    summary: 'Agents can also read the full events and messages of other threads.'
  }
]

/** Threads whose level stays lower than the setting, whatever it says (SPEC §15.1, static ceiling). */
export const CAPPED_THREADS: ReadonlyArray<{ id: string; label: string; cap: string }> = [
  { id: 'remote', label: 'Threads driven by a remote send, such as from a linked phone', cap: 'Lineage only' },
  { id: 'bots', label: 'Bot threads', cap: 'Lineage only' },
  { id: 'plan', label: 'Turns in Plan mode, and read-only subagents', cap: 'Read at most' }
]

/**
 * Settings > Agents > Agent access: how far an agent may reach beyond its own thread and its
 * subagents, and in which projects. The stored project list is empty for "every project", so the
 * screen names that choice outright and never lets a limited list become empty by switching off its
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

  /** One project or computer: its name and a switch, under the row it refines. */
  const choiceRow = (kind: 'project' | 'computer', key: string, label: string, checked: boolean, onChange: () => void, locked?: string) => {
    const id = `agent-access-${kind}-${key}`
    return (
      <SettingsRow
        key={id}
        indent
        title={label}
        htmlFor={id}
        control={
          <span title={locked}>
            <Switch id={id} label={label} checked={checked} disabled={Boolean(locked)} onChange={onChange} />
          </span>
        }
      />
    )
  }
  const lastProject = 'Keep at least one project on, or turn on All projects.'

  return (
    <SettingsGroup title="Agent access" icon={ShieldCheck}>
      <SettingsRow
        title="Reach beyond their own threads"
        anchor="agents-access"
        titleId="agent-access-level-title"
        description={<>
          <span id="agent-access-level-summary">{level.summary}</span>
          <MoreDetails>Lowering this applies to agents that are already running; raising it applies from their next turn.</MoreDetails>
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
        <>
          <SettingsRow
            title="Projects"
            description={everyProject
              ? 'Every project, including threads without a project. Turn on a project to limit this.'
              : `Only the projects turned on. New projects are not added. ${lastProject}`}
          />
          {/* Every project is widened to by its own switch; it is turned off by turning on a project. */}
          {choiceRow('project', '*', 'All projects', everyProject, () => { if (!everyProject) save({ projectIds: [] }) },
            everyProject ? 'Turn on a project to limit access to it.' : undefined)}
          {projects.map((project) =>
            choiceRow('project', project.id, project.name, !everyProject && access.projectIds.includes(project.id), () => toggleProject(project.id),
              !everyProject && access.projectIds.length === 1 && access.projectIds[0] === project.id ? lastProject : undefined)
          )}
          {removed.map((id) =>
            choiceRow('project', id, 'Removed project', true, () => toggleProject(id), access.projectIds.length === 1 ? lastProject : undefined)
          )}
        </>
      )}
      {access.level === 'manage' && (
        <SettingsRow
          title="Agents may answer approvals on other threads"
          anchor="agents-access-approvals"
          htmlFor="agent-access-answer-approvals"
          description={<>
            <strong>Use with care.</strong> Agents approve what other threads in these projects ask for, within their own permission mode.
            <MoreDetails>
              An agent can approve a command, a file change or a tool that another thread asked to run, without you seeing the request
              first. It can approve only what its own permission mode would allow without asking, never &ldquo;Always for this
              thread&rdquo;, and never its own thread. Each answer shows in that thread as approved by an agent. Requests the provider
              asks for itself (such as Claude Code&rsquo;s own safety check) and turns you started yourself stay yours. Off by
              default, and switched off again when the level above is lowered.
            </MoreDetails>
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
      <SettingsRow
        title="Let agents start subagents on your other devices"
        anchor="agents-remote-subagents"
        htmlFor="agent-access-remote-subagents"
        description={access.remoteSubagents && !(routed && computers.length > 0) && goneComputers.length === 0
          ? 'No other computers are connected yet. Pair them in Settings → Devices, then turn on the ones agents may use.'
          : <>
            Runs on the computers you turn on, at no more than Auto-accept edits.
            <MoreDetails>
              An agent can start a subagent on another of your computers. It runs there under that computer&rsquo;s agents and
              accounts, in its copy of the repository, at no more than Auto-accept edits and the limit that computer set for this one.
              Off by default.
            </MoreDetails>
          </>}
        control={
          <Switch
            id="agent-access-remote-subagents"
            label="Let agents start subagents on your other devices"
            checked={access.remoteSubagents}
            onChange={(remoteSubagents) => save({ remoteSubagents })}
          />
        }
      />
      {access.remoteSubagents && ((routed && computers.length > 0) || goneComputers.length > 0) ? (
        <>
          <SettingsRow title="Computers" description="Only the computers turned on. None are on at first." />
          {computers.map((computer) =>
            choiceRow('computer', computer.node, computer.online ? computer.name : `${computer.name} (offline)`, access.computers.includes(computer.node), () => toggleComputer(computer.node))
          )}
          {goneComputers.map((node) => choiceRow('computer', node, 'Removed computer', true, () => toggleComputer(node)))}
        </>
      ) : null}
      <AgentAutomationsSettings />
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

import { normalizeAgentAccessSettings, type MousseSettings, type MousseSettingsUpdate } from '../../../shared/settings'
import { useEffect, type ReactNode } from 'react'
import { MoreDetails, SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { GitFork, ShieldCheck } from '../../lib/icons'
import { useComputers } from '../../lib/computers'

/**
 * Settings > Agents > Access and Subagents: whether agents may answer approvals on other threads, then whether they
 * may work on the user's other devices ("Let agents work on your other devices", stored as `remoteSubagents`). Both read and write the one stored `agentAccess` setting. Agents read and
 * manage every thread; there is no level to choose (SPEC §15.1).
 */
export function AgentAccessSettings({
  settings,
  updateSettings,
  subagentRows
}: {
  settings: MousseSettings
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
  /** More rows for the Subagents group, after the remote subagents switch. */
  subagentRows?: ReactNode
}) {
  const access = normalizeAgentAccessSettings(settings.agentAccess)
  const { loaded, routed, byNode, devices } = useComputers()
  const computers = Object.values(byNode).sort((a, b) => a.name.localeCompare(b.name))
  // Only a device list that names this computer is the whole list: before it loads, or with Net off or locked,
  // an allowed computer is unknown, not gone.
  const listKnown = loaded && devices.some((device) => device.self)
  const goneKey = listKnown ? access.computers.filter((node) => !byNode[node]).join(',') : ''
  const toggleComputer = (node: string) =>
    save({ computers: access.computers.includes(node) ? access.computers.filter((entry) => entry !== node) : [...access.computers, node] })

  // Always the whole setting: a partial write must not drop the approvals switch or the computer list.
  const save = (next: Partial<typeof access>) => void updateSettings({ agentAccess: { ...access, ...next } })

  // A computer removed from the user's devices leaves the allowed list on its own.
  useEffect(() => {
    if (goneKey) save({ computers: access.computers.filter((node) => byNode[node]) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goneKey])

  /** One computer: its name and a switch, under the row it refines. */
  const choiceRow = (kind: 'computer', key: string, label: string, checked: boolean, onChange: () => void, locked?: string) => {
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

  return (
    <>
      <SettingsGroup title="Access" icon={ShieldCheck} anchor="agents-access">
        <SettingsRow
          title="Answer approvals on other threads"
          anchor="agents-access-approvals"
          htmlFor="agent-access-answer-approvals"
          description={<>
            <strong>Use with care.</strong> Agents approve what other threads ask for, within their own permission mode.
            <MoreDetails>
              An agent can approve a command, a file change or a tool that another thread asked to run, without you seeing the request
              first. It can approve only what its own permission mode would allow without asking, never &ldquo;Always for this
              thread&rdquo;, and never its own thread. Each answer shows in that thread as approved by an agent. Requests the provider
              asks for itself (such as Claude Code&rsquo;s own safety check) and turns you started yourself stay yours. Off by default.
            </MoreDetails>
          </>}
          control={
            <Switch
              id="agent-access-answer-approvals"
              label="Answer approvals on other threads"
              checked={access.answerApprovals}
              onChange={(answerApprovals) => save({ answerApprovals })}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Subagents" icon={GitFork} anchor="agents-subagents">
        <SettingsRow
          title="Let agents work on your other devices"
          anchor="agents-remote-subagents"
          htmlFor="agent-access-remote-subagents"
          description={access.remoteSubagents && !(routed && computers.length > 0)
            ? 'No other computers are connected yet. Pair them in Settings → Devices, then turn on the ones agents may use.'
            : <>
              Runs on the computers you turn on, within the limit each of them set for this one.
              <MoreDetails>
                An agent can start a subagent on another of your computers. It runs there under that computer&rsquo;s agents and
                accounts, in its copy of the repository, no looser than the agent that started it and within the limit that
                computer set for this one in its Devices settings. That computer also chooses which of its threads this
                computer&rsquo;s agents may change. Off by default.
              </MoreDetails>
            </>}
          control={
            <Switch
              id="agent-access-remote-subagents"
              label="Let agents work on your other devices"
              checked={access.remoteSubagents}
              onChange={(remoteSubagents) => save({ remoteSubagents })}
            />
          }
        />
        {access.remoteSubagents && routed && computers.length > 0 ? (
          <>
            <SettingsRow title="Computers" description="Only the computers turned on. None are on at first." />
            {computers.map((computer) =>
              choiceRow('computer', computer.node, computer.online ? computer.name : `${computer.name} (offline)`, access.computers.includes(computer.node), () => toggleComputer(computer.node))
            )}
          </>
        ) : null}
        {subagentRows}
      </SettingsGroup>
    </>
  )
}

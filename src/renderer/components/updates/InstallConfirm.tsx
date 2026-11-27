import { useEffect, useRef, useState } from 'react'
import { isTurnActivePhase } from '../../../shared/types'
import { computersCount, rolloutTargets, type RolloutRow } from '../../../shared/updateRollout'
import { rolloutActions, rowStatus, useRolloutStore } from '../../lib/updateRollout'
import { computerUpdateRows, computersUsingThis, oneWayNodes, type ComputerUpdateRow } from '../../lib/updateEverywhere'
import { useComputersStore } from '../../lib/computers'
import type { Device } from '../../lib/netDevices'
import { formatVersion } from '../providers/providerView'
import { useEngineStatus } from '../netEngine/useEngineStatus'
import type { UpdateState } from '../../../shared/updates'
import { useAppStore } from '../../stores/appStore'
import { updateActions, useUpdateStore } from '../../stores/updateStore'
import { FixedReports } from '../bugReports/FiledReports'
import { Modal } from '../ui/Modal'
import '../../styles/updates.css'

/** What else the install stops, besides this app's own service: everything that runs from the install folder. */
const OTHER_PROCESSES_DETAIL =
  'The installer cannot replace files that are in use. Services of other Mousse homes stop, and their running turns are interrupted. MCP hosts, bridges and mousse-cli commands using this install stop as well.'

/**
 * The turns a restart of this computer stops: this window's count at once, then the service's count across every
 * profile while the prompt is open.
 */
function useRunningTurns(open: boolean): number {
  const here = useAppStore((s) => Object.values(s.turnStates).filter((turn) => isTurnActivePhase(turn.phase)).length)
  const [service, setService] = useState<number | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    window.mousse?.updates?.runningTurns?.()
      .then((count) => {
        if (live) setService(typeof count === 'number' ? count : null)
      })
      .catch(() => undefined)
    return () => {
      live = false
      setService(null)
    }
  }, [open, here])
  return service ?? here
}

/**
 * The restart that installs a downloaded update. Used by the downloads popover and Settings, General. One line when
 * nothing else is affected; otherwise one row for each thing the restart touches, only those that apply: this
 * computer, the turns it stops, and each computer using this one.
 */
export function InstallConfirm({ open, version, onClose }: { open: boolean; version: string; onClose: () => void }) {
  const turns = useRunningTurns(open)
  return (
    <Modal open={open} title={`${formatVersion(version) ?? version} is ready`} onClose={onClose} className="update-prompt" footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Later</button>
      <button type="button" className="btn btn-primary" onClick={() => { onClose(); void updateActions.install() }}>Restart now</button>
    </>}>
      {open && <FixedReports />}
      {open && <RestartEffects version={version} turns={turns} />}
    </Modal>
  )
}

function RestartEffects({ version, turns }: { version: string; turns: number }) {
  const current = useUpdateStore((s) => s.currentVersion)
  const devices = useComputersStore((s) => s.devices)
  const { status } = useEngineStatus()
  const users = computersUsingThis(devices, status?.on ? status : undefined)
  if (turns === 0 && users.length === 0)
    return <p className="update-prompt-line" title={OTHER_PROCESSES_DETAIL}>Mousse restarts to finish updating. It's back in a few seconds.</p>
  const from = formatVersion(current)
  return (
    <ul className="rollout-rows update-prompt-rows" aria-label="What the restart affects">
      <li className="rollout-row" title={OTHER_PROCESSES_DETAIL}>
        <span className="rollout-row-name">This computer</span>
        <span className="rollout-row-version">{from ? `${from} → ${formatVersion(version)}` : formatVersion(version)}</span>
        <span className="rollout-row-status">Back in a few seconds</span>
      </li>
      {turns > 0 && (
        // Nothing resumes by itself after a restart: each turn is marked interrupted and continued from its thread.
        <li className="rollout-row" data-tone="warn" title="Each one is marked interrupted. Continue it from its thread after the restart.">
          <span className="rollout-row-name">{turns === 1 ? '1 running turn' : `${turns} running turns`}</span>
          <span className="rollout-row-version" />
          <span className="rollout-row-status">Stop, continue them after</span>
        </li>
      )}
      {users.map((user) => (
        <li key={user.node} className="rollout-row" title={`${user.name} uses this computer and reconnects by itself.`}>
          <span className="rollout-row-name">{user.name}</span>
          <span className="rollout-row-version" />
          <span className="rollout-row-status">Reconnects after</span>
        </li>
      ))}
    </ul>
  )
}

/** The computers' rows for a rollout to `target`: the service's `rows` when given, else its plan once read. */
export function useComputerUpdateRows(target: string, rows?: readonly RolloutRow[]): ComputerUpdateRow[] {
  const devices: readonly Device[] = useComputersStore((s) => s.devices)
  const current = useUpdateStore((s) => s.currentVersion) || undefined
  const plan = useRolloutStore((s) => (s.planFor === target ? s.plan : undefined))
  const { status } = useEngineStatus()
  return computerUpdateRows({ devices, oneWay: oneWayNodes(status?.on ? status : undefined), plan: rows ?? plan, current, target })
}

/**
 * Update everywhere's confirmation: what happens on each computer, then the skipped ones with their reason. Opening it
 * starts every computer downloading `version`; nothing installs until the person confirms. Cancel (or closing it)
 * drops the downloads. Other computers install first; this one restarts last.
 */
export function RolloutConfirm({ open, version, onClose }: { open: boolean; version: string; onClose: () => void }) {
  const rollout = useRolloutStore((s) => (s.rollout?.version === version && s.rollout.step === 'preparing' && !s.rollout.confirmedAt ? s.rollout : null))
  const plan = useRolloutStore((s) => (s.planFor === version ? s.plan : undefined))
  const error = useRolloutStore((s) => s.error)
  // Closed before the start answered: the rollout it started is dropped once it has.
  const closed = useRef(false)
  useEffect(() => {
    if (!open) return
    closed.current = false
    useRolloutStore.setState({ error: undefined })
    void rolloutActions.start(version).then((started) => {
      if (started && closed.current) void rolloutActions.cancel()
    })
    return () => {
      closed.current = true
    }
  }, [open, version])
  const service: readonly RolloutRow[] = rollout?.rows ?? plan ?? []
  const rows = useComputerUpdateRows(version, rollout?.rows ?? plan).filter((row) => !row.current)
  const byNode = new Map(service.map((row) => [row.node, row]))
  const count = rolloutTargets(service).length
  const turns = rolloutTargets(service).reduce((sum, row) => sum + (row.runningTurns ?? 0), 0)
  const cancel = (): void => {
    closed.current = true
    if (rollout) void rolloutActions.cancel()
    onClose()
  }
  const install = (): void => {
    if (!rollout) return
    closed.current = false
    void rolloutActions.confirm(rollout)
    onClose()
  }
  const to = formatVersion(version) ?? version
  return (
    <Modal open={open} title={`Update ${computersCount(count)} to ${to}?`} onClose={cancel} className="update-prompt update-everywhere" footer={<>
      <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={!rollout || count === 0} onClick={install}>Update {computersCount(count)}</button>
    </>}>
      <ul className="rollout-rows" aria-label="Computers">
        {rows.map((row) => {
          const live = byNode.get(row.node)
          const failed = row.updates && live?.phase === 'failed'
          return (
            <li key={row.node} className="rollout-row" data-tone={failed ? 'bad' : row.updates ? undefined : 'muted'} title={(failed ? live?.error : row.detail) || undefined}>
              <span className="rollout-row-name">{row.name}</span>
              <span className="rollout-row-version">{row.updates ? `${formatVersion(row.from) ?? 'Older version'} → ${to}` : (formatVersion(row.from) ?? '')}</span>
              <span className="rollout-row-status">{failed && live ? rowStatus(live) : row.plan}</span>
            </li>
          )
        })}
      </ul>
      {error && <p className="rollout-error" role="alert">{error}</p>}
      <p className="update-prompt-line" title={OTHER_PROCESSES_DETAIL}>{turns > 0
        ? `${turns} running agent turn${turns === 1 ? '' : 's'} on these computers ${turns === 1 ? 'is' : 'are'} stopped and marked interrupted.`
        : 'Running agent turns on these computers are stopped and marked interrupted.'}</p>
    </Modal>
  )
}

/** What the offered update brings, newest release first. */
export function ReleaseNotes({ state }: { state: Pick<UpdateState, 'releaseNotes' | 'omittedReleaseCount'> }) {
  const groups = state.releaseNotes.filter((group) => group.items.length > 0)
  if (groups.length === 0) return null
  return (
    <section className="update-notes" aria-label="What's changed">
      <FixedReports />
      {groups.map((group) => {
        const more = group.totalItems - group.items.length
        return (
          <div key={group.version} className="update-notes-group">
            {groups.length > 1 && <h4>{group.version}</h4>}
            <ul>{group.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
            <a href={group.url} target="_blank" rel="noopener noreferrer">
              {more > 0 ? `${more} more change${more === 1 ? '' : 's'} on GitHub` : 'View release on GitHub'}
            </a>
          </div>
        )
      })}
      {state.omittedReleaseCount > 0 &&
        <p className="update-notes-more">{state.omittedReleaseCount} earlier release{state.omittedReleaseCount === 1 ? '' : 's'} not shown</p>}
    </section>
  )
}

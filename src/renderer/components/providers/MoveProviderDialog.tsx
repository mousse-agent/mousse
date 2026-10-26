import { useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { foldedInto, type MoveResult } from '../../../shared/harness/move'
import { piProviderIdOf } from '../../../shared/providerInstances'
import { Modal } from '../ui/Modal'
import { SettingsRow } from '../settings/SettingsRow'
import { useAsyncAction } from './parts'
import { DRIVER_INFO } from './providerView'

/**
 * A model API that now runs as an agent (`FOLDED_INTO_AGENT`) says so on its card and offers Move.
 * Moving never happens on its own: the old entry is turned off (not deleted), and the defaults
 * that named it are rewritten and listed here.
 */

/** The agent entries a model API entry can move to; empty when it moves nowhere. */
export function moveTargets(snapshot: InstanceSnapshot, snapshots: readonly InstanceSnapshot[]): InstanceSnapshot[] {
  const agent = foldedInto(piProviderIdOf(snapshot.instanceId))
  if (!agent || snapshot.config?.movedTo) return []
  return snapshots.filter((entry) => entry.driver === agent)
}

export function MoveNotice({
  snapshot,
  snapshots,
  onMove
}: {
  snapshot: InstanceSnapshot
  snapshots: readonly InstanceSnapshot[]
  onMove: (toInstanceId: string, options: { copyKey: boolean }) => Promise<MoveResult>
}) {
  const [open, setOpen] = useState(false)
  const agent = foldedInto(piProviderIdOf(snapshot.instanceId))
  if (!agent) return null
  const label = DRIVER_INFO[agent].label
  if (snapshot.config?.movedTo) {
    const target = snapshots.find((entry) => entry.instanceId === snapshot.config?.movedTo)
    return <SettingsRow title="Moved" description={`This entry moved to ${target?.displayName ?? label} and is off. Remove it when you no longer need it.`} />
  }
  return (
    <>
      <SettingsRow
        title={`Runs as ${label} now`}
        description={`${snapshot.displayName} now runs as an agent with your account.`}
        control={
          <button type="button" className="settings-btn" onClick={() => setOpen(true)}>
            Move…
          </button>
        }
      />
      {open && (
        <MoveProviderDialog snapshot={snapshot} targets={moveTargets(snapshot, snapshots)} agentLabel={label} onMove={onMove} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

export function MoveProviderDialog({
  snapshot,
  targets,
  agentLabel,
  onMove,
  onClose
}: {
  snapshot: InstanceSnapshot
  targets: readonly InstanceSnapshot[]
  agentLabel: string
  onMove: (toInstanceId: string, options: { copyKey: boolean }) => Promise<MoveResult>
  onClose: () => void
}) {
  const [target, setTarget] = useState(targets[0]?.instanceId ?? '')
  // The key is copied only when the user ticks it.
  const [copyKey, setCopyKey] = useState(false)
  const hasKey = snapshot.auth.state === 'signed_in' && snapshot.auth.methodLabel === 'API key'
  const [result, setResult] = useState<MoveResult | null>(null)
  const { busy, error, run } = useAsyncAction()
  const footer = result ? (
    <button type="button" className="btn btn-primary" onClick={onClose}>
      Done
    </button>
  ) : (
    <>
      <button type="button" className="btn" disabled={busy !== null} onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy !== null || !target}
        onClick={() => void run('move', async () => setResult(await onMove(target, { copyKey: hasKey && copyKey })))}
      >
        {busy ? 'Moving…' : 'Move'}
      </button>
    </>
  )
  return (
    <Modal open title={`Move ${snapshot.displayName}`} onClose={onClose} footer={footer}>
      {result ? (
        <div className="prov-wizard-panel">
          <p>{snapshot.displayName} is off now. Chats that used it continue on the agent with their history.</p>
          {result.rewritten.length > 0 ? (
            <>
              <p>These defaults now use the agent:</p>
              <ul>
                {result.rewritten.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No default used it.</p>
          )}
        </div>
      ) : targets.length === 0 ? (
        <p className="settings-muted">Add {agentLabel} first, then move this entry to it.</p>
      ) : (
        <div className="prov-wizard-panel">
          {error && <p className="prov-error">{error}</p>}
          <p>
            Mousse turns {snapshot.displayName} off (it is not deleted) and moves the defaults that use it. Chats that used it continue on {agentLabel} with
            their history.
          </p>
          <div role="radiogroup" aria-label="Move to" className="prov-choice-grid">
            {targets.map((entry) => (
              <button
                key={entry.instanceId}
                type="button"
                role="radio"
                aria-checked={entry.instanceId === target}
                className={`prov-choice${entry.instanceId === target ? ' is-checked' : ''}`}
                onClick={() => setTarget(entry.instanceId)}
              >
                <span className="prov-choice-label">{entry.displayName}</span>
              </button>
            ))}
          </div>
          {hasKey ? (
            <label className="prov-check-row">
              <input type="checkbox" checked={copyKey} onChange={(event) => setCopyKey(event.target.checked)} />
              <span>Use the same API key for {agentLabel}</span>
            </label>
          ) : (
            <p className="settings-muted">Sign in to {agentLabel} on its entry after the move.</p>
          )}
        </div>
      )}
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { acceptsMove, foldedInto, foldedTarget, moveBannerOf, threadMoveBanner, type MoveResult } from '../../../shared/harness/move'
import { piProviderIdOf } from '../../../shared/providerInstances'
import { applySnapshot } from '../../lib/providerSnapshots'
import { Modal } from '../ui/Modal'
import { SettingsRow } from '../settings/SettingsRow'
import { MoveBannerView } from './MoveBanner'
import { CommandBox, useAsyncAction } from './parts'
import { DRIVER_INFO, isManagedSetup } from './providerView'
import { SignInDialog } from './SignInDialog'

/**
 * A model API that now runs as an agent (`FOLDED_INTO_AGENT`) says so on its card and offers Move.
 * Moving never happens on its own: the old entry is turned off (not deleted), and the defaults
 * that named it are rewritten and listed here. An entry whose old route is going away (a Move
 * banner) moves only onto an agent that is installed and signed in, so the dialog signs it in first.
 * A model API that moves to a narrower kind of entry (`FOLDED_TARGETS`: Anthropic → Claude Code on
 * an API key) moves only to such an entry, and the dialog offers to add one when there is none.
 */

/** Where a move goes: an existing entry, or a new one of the target kind (`null`). */
export type MoveTarget = string | null

/** What the dialog can do for the entry it moves to. */
export interface MoveHandlers {
  onMove: (to: MoveTarget, options: { copyKey: boolean }) => Promise<MoveResult>
  /** Starts the sign-in of an entry Mousse signs in (its prompts open the sign-in dialog). */
  onSignIn?: (target: InstanceSnapshot) => Promise<void>
  /** Checks an entry again (a sign-in finished in a terminal). */
  onRecheck?: (target: InstanceSnapshot) => Promise<void>
}

/** The agent entries a model API entry can move to; empty when it moves nowhere. */
export function moveTargets(snapshot: InstanceSnapshot, snapshots: readonly InstanceSnapshot[]): InstanceSnapshot[] {
  const providerId = piProviderIdOf(snapshot.instanceId)
  const agent = foldedInto(providerId)
  if (!agent || snapshot.config?.movedTo) return []
  return snapshots.filter((entry) => entry.driver === agent && acceptsMove(providerId, entry.config))
}

/** Whether a chat can run on the entry now: installed, and signed in. */
export function isMoveReady(target: InstanceSnapshot): boolean {
  return target.install.state === 'installed' && target.auth.state === 'signed_in'
}

/** How a target runs, under its name in the dialog. */
function targetDescription(target: InstanceSnapshot): string {
  return isManagedSetup(target) ? 'Managed by Mousse, signs in with ChatGPT' : 'Your installed CLI, with its own sign-in'
}

/**
 * The Move dialog with its own sign-in: the entry's own Move calls and, for a target that must be
 * signed in first, the sign-in dialog on top of it. Used by the card and by a chat's banner.
 */
export function MoveDialogHost({
  snapshot,
  snapshots,
  onMoved,
  onClose
}: {
  snapshot: InstanceSnapshot
  snapshots: readonly InstanceSnapshot[]
  /** Called once the entry moved (the page reloads what it shows). */
  onMoved?: () => Promise<void> | void
  onClose: () => void
}) {
  const [signIn, setSignIn] = useState<{ operationId: string; name: string } | null>(null)
  const agent = foldedInto(piProviderIdOf(snapshot.instanceId))
  if (!agent) return null
  const { instances } = window.mousse.providers
  return (
    <>
      <MoveProviderDialog
        snapshot={snapshot}
        targets={moveTargets(snapshot, snapshots)}
        agentLabel={DRIVER_INFO[agent].label}
        onMove={async (to, options) => {
          // No entry of the target kind yet (Claude Code on an API key): one is added first, or one an
          // earlier try added is reused, then the entry moves to it.
          const toInstanceId = to ?? (await addMoveTarget(snapshot))
          const result = await instances.move(snapshot.instanceId, toInstanceId, options)
          await onMoved?.()
          return result
        }}
        onSignIn={async (target) => {
          const started = await instances.signIn(target.instanceId)
          setSignIn({ operationId: started.operationId, name: target.displayName })
        }}
        onRecheck={async (target) => applySnapshot(await instances.recheck(target.instanceId))}
        onClose={onClose}
      />
      <SignInDialog operationId={signIn?.operationId ?? null} name={signIn?.name ?? ''} onClose={() => setSignIn(null)} />
    </>
  )
}

/** Adds the entry a model API moves to when none exists (`FOLDED_TARGETS`), or reuses one already there. */
async function addMoveTarget(snapshot: InstanceSnapshot): Promise<string> {
  const { instances } = window.mousse.providers
  const providerId = piProviderIdOf(snapshot.instanceId)
  const driver = foldedInto(providerId)
  const target = foldedTarget(providerId)
  if (!driver || !target) throw new Error(`${snapshot.displayName} has nowhere to move to.`)
  const existing = moveTargets(snapshot, await window.mousse.providers.snapshots({ kind: 'device' }))[0]
  if (existing) return existing.instanceId
  const added = await instances.add({ driver, config: { displayName: target.displayName, home: 'private', loginMethod: target.loginMethod }, slug: target.slug })
  applySnapshot(added)
  return added.instanceId
}

/**
 * The card's Move prompt. `banner`: the persistent banner of an entry whose old route is going away,
 * shown above its Setup. `row`: the quiet row of any other entry that runs as an agent now (or the
 * note that it moved), inside Setup. The editor renders both; each shows only its own case.
 */
export function MoveNotice({
  snapshot,
  snapshots,
  variant = 'row',
  onMoved
}: {
  snapshot: InstanceSnapshot
  snapshots: readonly InstanceSnapshot[]
  variant?: 'banner' | 'row'
  onMoved?: () => Promise<void> | void
}) {
  const [open, setOpen] = useState(false)
  const agent = foldedInto(piProviderIdOf(snapshot.instanceId))
  if (!agent) return null
  const label = DRIVER_INFO[agent].label
  const kind = foldedTarget(piProviderIdOf(snapshot.instanceId))
  const banner = moveBannerOf(snapshot)
  const movedTo = snapshot.config?.movedTo
  let shown = null
  if (variant === 'banner') {
    if (banner) shown = <MoveBannerView banner={banner} onMove={() => setOpen(true)} />
  } else if (!banner) {
    shown = movedTo ? (
      <SettingsRow
        title="Moved"
        description={`This entry moved to ${snapshots.find((entry) => entry.instanceId === movedTo)?.displayName ?? kind?.displayName ?? label} and is off. Remove it when you no longer need it.`}
      />
    ) : (
      <SettingsRow
        title={`Runs as ${label} now`}
        description={
          kind
            ? `${snapshot.displayName} now runs through ${label}, on your API key. Move it to ${kind.displayName} when you are ready.`
            : `${snapshot.displayName} now runs as an agent with your account.`
        }
        control={
          <button type="button" className="settings-btn" onClick={() => setOpen(true)}>
            Move…
          </button>
        }
      />
    )
  }
  // The dialog stays up after the move (it lists what changed), though the entry now reads as moved.
  return (
    <>
      {shown}
      {open && <MoveDialogHost snapshot={snapshot} snapshots={snapshots} onMoved={onMoved} onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * The Move banner at the top of a chat whose selection is `instanceId`, when that entry has one (the
 * same dialog as the card's). The dialog outlives the banner: it lists what the move changed.
 */
export function ThreadMoveBanner({ instanceId, snapshots }: { instanceId: string | undefined; snapshots: readonly InstanceSnapshot[] | undefined }) {
  const [open, setOpen] = useState(false)
  const banner = threadMoveBanner(instanceId, snapshots)
  const snapshot = snapshots?.find((entry) => entry.instanceId === instanceId)
  return (
    <>
      {banner && <MoveBannerView banner={banner} onMove={() => setOpen(true)} />}
      {open && snapshot && snapshots && <MoveDialogHost snapshot={snapshot} snapshots={snapshots} onClose={() => setOpen(false)} />}
    </>
  )
}

/** What became of the old sign-in, said after "… is off now". */
export function oldSignInNote(result: MoveResult): string {
  if (result.oldSignIn === 'kept_shared') return ', and its old sign-in stays because another profile still uses it'
  if (result.oldSignIn === 'remains') return ', but its old sign-in could not be removed and stays unused'
  return ' and its old sign-in is removed'
}

/** What the chosen target still needs before an entry with a Move banner can move onto it. */
function TargetReadiness({ target, onSignIn, onRecheck }: { target: InstanceSnapshot; onSignIn?: MoveHandlers['onSignIn']; onRecheck?: MoveHandlers['onRecheck'] }) {
  const { busy, error, run } = useAsyncAction()
  if (isMoveReady(target)) return <p className="settings-muted">{target.displayName} is signed in. Moving turns the old connection off and removes its sign-in, unless another profile still uses it.</p>
  const command = target.nextStep?.command
  const idle = busy === null
  return (
    <div className="prov-wizard-panel">
      {error && <p className="prov-error">{error}</p>}
      {target.install.state !== 'installed' ? (
        <p className="settings-muted">Install {target.displayName} first (Settings → Providers), then come back to move.</p>
      ) : target.auth.canSignIn && onSignIn ? (
        <>
          <p className="settings-muted">Sign in to {target.displayName} first. Nothing moves until you have, and no sign-in is copied from the old connection.</p>
          <button type="button" className="settings-btn move-target-action" disabled={!idle} onClick={() => void run('signin', () => onSignIn(target))}>
            {target.config?.setup === 'managed' ? 'Continue with ChatGPT' : 'Sign in'}
          </button>
        </>
      ) : (
        <>
          <p className="settings-muted">{command ? 'Run this in a terminal, then check again.' : `Sign in to ${target.displayName} first.`}</p>
          {command && <CommandBox command={command} label="Copy sign-in command" />}
          {onRecheck && (
            <button type="button" className="settings-btn move-target-action" disabled={!idle} onClick={() => void run('recheck', () => onRecheck(target))}>
              Check again
            </button>
          )}
        </>
      )}
    </div>
  )
}

export function MoveProviderDialog({
  snapshot,
  targets,
  agentLabel,
  onMove,
  onSignIn,
  onRecheck,
  onClose
}: {
  snapshot: InstanceSnapshot
  targets: readonly InstanceSnapshot[]
  agentLabel: string
  onClose: () => void
} & MoveHandlers) {
  const kind = foldedTarget(piProviderIdOf(snapshot.instanceId))
  // With a target kind, a move can always go somewhere: a new entry of that kind when none exists.
  const [target, setTarget] = useState<MoveTarget | ''>(targets[0]?.instanceId ?? (kind ? null : ''))
  // A try that added the entry and then failed (its key copy) leaves it listed: the retry moves there.
  useEffect(() => {
    if (target === null && targets[0]) setTarget(targets[0].instanceId)
  }, [target, targets])
  // Copied only when the user leaves it ticked; the target kind says whether it starts ticked.
  const [copyKey, setCopyKey] = useState(kind?.copyKey ?? false)
  // An entry with a Move banner has an old sign-in that goes with it; nothing is copied. Read once:
  // after the move the entry no longer carries the banner, and the result still says what happened.
  const [retiring] = useState(() => moveBannerOf(snapshot) !== null)
  const hasKey = !retiring && snapshot.auth.state === 'signed_in' && snapshot.auth.methodLabel === 'API key'
  const [result, setResult] = useState<MoveResult | null>(null)
  const { busy, error, run } = useAsyncAction()
  const chosen = targets.find((entry) => entry.instanceId === target)
  const ready = !retiring || (chosen !== undefined && isMoveReady(chosen))
  const destination = kind?.displayName ?? agentLabel
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
        disabled={busy !== null || target === '' || !ready}
        onClick={() => void run('move', async () => setResult(await onMove(target === '' ? null : target, { copyKey: hasKey && copyKey })))}
      >
        {busy ? 'Moving…' : 'Move'}
      </button>
    </>
  )
  return (
    <Modal open title={`Move ${snapshot.displayName}`} onClose={onClose} footer={footer}>
      {result ? (
        <div className="prov-wizard-panel">
          <p>
            {snapshot.displayName} is off now{retiring ? oldSignInNote(result) : ''}. Chats that used it continue on the agent with their history.
          </p>
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
      ) : targets.length === 0 && !kind ? (
        <p className="settings-muted">Add {agentLabel} first, then move this entry to it.</p>
      ) : (
        <div className="prov-wizard-panel">
          {error && <p className="prov-error">{error}</p>}
          <p>
            Mousse turns {snapshot.displayName} off (it is not deleted{kind ? ', and its saved key stays' : ''}) and moves the defaults that use it. Chats that
            used it continue on {agentLabel} with their history.
          </p>
          {kind && (
            <p>
              {destination} runs {agentLabel} on an API key, in a home of its own: your own {agentLabel} setup is not changed. Pinned models keep the same
              model where {agentLabel} has it, else its model of the same family, else its default.
            </p>
          )}
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
                <span className="prov-registry-text">
                  <span className="prov-choice-label">{entry.displayName}</span>
                  {retiring && targetDescription(entry) && <span className="settings-muted">{targetDescription(entry)}</span>}
                </span>
              </button>
            ))}
            {kind && targets.length === 0 && (
              <button type="button" role="radio" aria-checked={target === null} className={`prov-choice${target === null ? ' is-checked' : ''}`} onClick={() => setTarget(null)}>
                <span className="prov-choice-label">{kind.displayName} (new)</span>
              </button>
            )}
          </div>
          {retiring && chosen && <TargetReadiness target={chosen} onSignIn={onSignIn} onRecheck={onRecheck} />}
          {!retiring &&
            (hasKey ? (
              <label className="prov-check-row">
                <input type="checkbox" checked={copyKey} onChange={(event) => setCopyKey(event.target.checked)} />
                <span>{kind ? 'Copy my API key' : `Use the same API key for ${agentLabel}`}</span>
              </label>
            ) : (
              <p className="settings-muted">Sign in to {destination} on its entry after the move.</p>
            ))}
        </div>
      )}
    </Modal>
  )
}

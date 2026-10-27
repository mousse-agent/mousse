import { useEffect, useRef, useState } from 'react'
import { Modal } from '../ui/Modal'
import { CopyButton } from '../settings/IconButtons'
import type { NetAddonActionResult, NetAddonChange } from '../../../shared/net/local'

type Refusal = Extract<NetAddonActionResult, { ok: false }>
type Phase = 'loading' | 'plan' | 'running' | 'done' | 'undoing' | 'undone' | 'refused'

/**
 * Shows what a change to this computer or network will do, runs it on confirmation, and offers to
 * undo it right after. Each call returns a result, so a refusal reads as text with an optional
 * command for the user to run, never as a thrown error.
 */
export function ChangePlanDialog({
  title,
  describe,
  apply,
  undo,
  onClose,
  onChanged
}: {
  title: string
  describe: () => Promise<NetAddonActionResult>
  apply: () => Promise<NetAddonActionResult>
  undo: () => Promise<NetAddonActionResult>
  onClose: () => void
  /** After a change was applied or undone, so the screen behind can reload. */
  onChanged?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [changes, setChanges] = useState<NetAddonChange[]>([])
  const [problem, setProblem] = useState<Pick<Refusal, 'message' | 'remedy'>>()
  const [outcome, setOutcome] = useState<string>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void describe().then(
      (result) => {
        if (!alive.current) return
        if (result.ok) { setChanges(result.changes ?? []); setPhase('plan') }
        else { setProblem(result); setPhase('refused') }
      },
      (cause) => { if (alive.current) { setProblem({ message: String((cause as Error)?.message ?? cause) }); setPhase('refused') } }
    )
    return () => { alive.current = false }
    // The plan is read once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const step = async (work: () => Promise<NetAddonActionResult>, during: Phase, after: Phase) => {
    setPhase(during); setProblem(undefined)
    try {
      const result = await work()
      if (!alive.current) return
      if (result.ok) { setPhase(after); if (after === 'undone') setOutcome(result.message); onChanged?.() }
      else { setProblem(result); setPhase(after === 'done' ? 'plan' : 'done') }
    } catch (cause) {
      if (alive.current) { setProblem({ message: String((cause as Error)?.message ?? cause) }); setPhase(after === 'done' ? 'plan' : 'done') }
    }
  }

  const busy = phase === 'running' || phase === 'undoing'
  const footer =
    phase === 'plan' ? <button type="button" className="settings-btn devices-dialog-btn primary" onClick={() => void step(apply, 'running', 'done')}>Run</button>
      : phase === 'done' ? <button type="button" className="settings-btn devices-dialog-btn" onClick={() => void step(undo, 'undoing', 'undone')}>Undo</button>
        : undefined

  return (
    <Modal open title={title} onClose={() => { if (!busy) onClose() }} footer={footer}>
      <div className="devices-dialog">
        {phase === 'loading' && <p className="settings-muted" role="status">Checking what this will change…</p>}
        {(phase === 'plan' || phase === 'running' || phase === 'done' || phase === 'undoing') && (
          <>
            <p className="settings-muted">
              {phase === 'plan' ? 'This is what will change.'
                : phase === 'running' ? 'Making the change…'
                  : phase === 'undoing' ? 'Undoing…'
                    : 'Done. Undo puts back only what this changed.'}
            </p>
            <ul className="change-plan">
              {changes.map((change) => (
                <li key={change.title}>
                  <strong>{change.title}</strong>
                  <span className="settings-muted">{change.detail}</span>
                  {change.command && (
                    <span className="change-plan-command">
                      <code className="devices-code">{change.command}</code>
                      <CopyButton text={change.command} label="Copy command" />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {phase === 'undone' && <p role="status">{outcome ?? 'Undone.'}</p>}
        {problem && (
          <div role="alert" className="chat-error">
            <p>{problem.message}</p>
            {problem.remedy && (
              <span className="change-plan-command">
                <code className="devices-code">{problem.remedy}</code>
                <CopyButton text={problem.remedy} label="Copy command" />
              </span>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

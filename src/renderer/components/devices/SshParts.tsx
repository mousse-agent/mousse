import { CopyButton } from '../settings/IconButtons'
import type { SshPlan, SshSetupStatus, SshUndoResult } from '../../../shared/net/local'

/** A command the user may need to run, with a copy button. */
export function CommandLine({ command, label = 'Copy command' }: { command: string; label?: string }) {
  return (
    <div className="devices-command">
      <code className="devices-code">{command}</code>
      <CopyButton text={command} label={label} />
    </div>
  )
}

type StepState = SshSetupStatus['steps'][number]['state']
const STEP_WORD: Record<StepState, [string, string]> = {
  pending: ['Waiting', 'settings-muted'],
  done: ['Done', 'settings-status-ok'],
  failed: ['Failed', 'settings-status-bad'],
  unknown: ['Unclear', 'settings-status-warn'],
  skipped: ['Skipped', 'settings-muted']
}

/** Setup steps with their state, named by the plan when the dialog has it. */
export function SetupSteps({ status, plan }: { status: SshSetupStatus; plan?: SshPlan }) {
  const running = status.phase === 'running'
  return (
    <ul className="devices-steps" aria-label="Setup steps">
      {status.steps.map((item) => {
        const [word, tone] = running && item.step === status.step && item.state === 'pending' ? ['Running', ''] : STEP_WORD[item.state]
        return (
          <li key={item.step}>
            <span>{plan?.steps.find((step) => step.id === item.step)?.title ?? item.step}</span>
            <span className={tone}>{word}</span>
          </li>
        )
      })}
    </ul>
  )
}

const UNDO_WORD: Record<SshUndoResult['report'][number]['result'], [string, string]> = {
  undone: ['Removed', 'settings-status-ok'],
  left: ['Left in place', 'settings-status-warn'],
  skipped: ['Skipped', 'settings-muted']
}

/** What undo removed from the remote machine, and the commands left for the user. */
export function UndoReport({ result }: { result: SshUndoResult }) {
  return (
    <>
      <p role="status">{result.ok ? 'Setup changes were undone.' : 'Some setup changes could not be undone.'}</p>
      {result.report.length > 0 && (
        <ul className="devices-steps" aria-label="Undo report">
          {result.report.map((line, index) => (
            <li key={`${line.step}-${index}`}>
              <span>{line.step}{line.detail && <span className="settings-muted"> · {line.detail}</span>}</span>
              <span className={UNDO_WORD[line.result][1]}>{UNDO_WORD[line.result][0]}</span>
            </li>
          ))}
        </ul>
      )}
      {result.commands.length > 0 && (
        <>
          <p>To finish, run these on the remote machine:</p>
          {result.commands.map((command) => <CommandLine key={command} command={command} />)}
        </>
      )}
    </>
  )
}

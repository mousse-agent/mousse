import { useState } from 'react'
import type { EditorHelp } from '../../lib/editorConnection'
import { CopyButton } from '../settings/IconButtons'

export interface EditorStateAction {
  key: string
  label: string
  onClick: () => void
}

/**
 * Why an editor cannot open a folder of another computer, under the editor button: one terse line and one
 * action. The longer words are the line's tooltip, or sit behind a link ("How to turn on") that the person opens
 * on purpose. `tone` says whether it is a refusal (`alert`) or only progress or an answer (`status`).
 */
export function EditorStateNote({
  help,
  actions,
  tone = 'alert',
  busy,
  opened = false
}: {
  help: Pick<EditorHelp, 'message' | 'tip' | 'steps' | 'stepsLabel' | 'command' | 'stepsAlongside'>
  actions: readonly EditorStateAction[]
  tone?: 'alert' | 'status'
  /** An action is under way: the buttons wait. */
  busy?: boolean
  /** Start with the steps already shown. */
  opened?: boolean
}) {
  const [shown, setShown] = useState(opened)
  const hidden = Boolean(help.steps) && !shown
  // The steps are the way on (the action follows them), unless they are only a side path.
  const behindLink = hidden && !help.stepsAlongside
  return (
    <div className="side-card-open-editor-note state" role={tone === 'alert' ? 'alert' : 'status'}>
      <p className="side-card-open-editor-line">
        <span title={help.tip}>{help.message}</span>
        {behindLink ? (
          <button type="button" className="side-card-open-editor-link" data-action="steps" onClick={() => setShown(true)}>
            {help.stepsLabel ?? 'How to fix'}
          </button>
        ) : (
          <>
            {actions.map((action) => (
              <button key={action.key} type="button" className="side-card-open-editor-link" data-action={action.key} disabled={busy} onClick={action.onClick}>
                {action.label}
              </button>
            ))}
            {hidden && (
              <button type="button" className="side-card-open-editor-link" data-action="steps" onClick={() => setShown(true)}>
                {help.stepsLabel ?? 'How to fix'}
              </button>
            )}
          </>
        )}
      </p>
      {!hidden && help.steps && <p className="side-card-open-editor-steps">{help.steps}</p>}
      {!hidden && help.command && (
        <p className="side-card-open-editor-command">
          <code>{help.command.text}</code>
          <CopyButton text={help.command.text} label={help.command.label} />
        </p>
      )}
    </div>
  )
}

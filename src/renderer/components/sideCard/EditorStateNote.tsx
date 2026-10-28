import type { EditorHelp } from '../../lib/editorConnection'
import { CopyButton } from '../settings/IconButtons'

export interface EditorStateAction {
  key: string
  label: string
  onClick: () => void
}

/**
 * Why an editor cannot open a folder of another computer, under the editor button: the state in a sentence, what
 * to do about it, anything to copy, and a button for each thing Mousse can do. `tone` says whether it is a
 * refusal (`alert`) or only progress or an answer (`status`).
 */
export function EditorStateNote({
  help,
  actions,
  tone = 'alert',
  busy
}: {
  help: Pick<EditorHelp, 'message' | 'next' | 'detail' | 'command'>
  actions: readonly EditorStateAction[]
  tone?: 'alert' | 'status'
  /** An action is under way: the buttons wait. */
  busy?: boolean
}) {
  return (
    <div className="side-card-open-editor-note state" role={tone === 'alert' ? 'alert' : 'status'}>
      <p>
        {help.message}
        {help.next ? ` ${help.next}` : ''}
      </p>
      {help.detail && <p className="side-card-open-editor-detail">{help.detail}</p>}
      {help.command && (
        <p className="side-card-open-editor-command">
          <code>{help.command.text}</code>
          <CopyButton text={help.command.text} label={help.command.label} />
        </p>
      )}
      {actions.length > 0 && (
        <div className="side-card-open-editor-actions">
          {actions.map((action) => (
            <button key={action.key} type="button" className="side-card-open-editor-link" data-action={action.key} disabled={busy} onClick={action.onClick}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

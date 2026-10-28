import { Code2 } from '../../lib/icons'
import { editorSshProblemWords, editorSshSwitch, useEditorSsh } from '../../lib/editorSsh'
import type { EditorSshStatus } from '../../../shared/net/local'
import { SettingsGroup, SettingsRow, Switch } from '../settings/SettingsRow'
import { EditorSshNoticeView } from '../sideCard/EditorSshNotice'

const TITLE = 'Let my editor reach my other computers'

/** The switch and undo for the `Include` line Mousse keeps in `~/.ssh/config`, given the data. */
export function EditorSshSettingsView({
  status,
  busy,
  error,
  onToggle,
  onDismissNotice
}: {
  status: EditorSshStatus | null
  busy?: boolean
  error?: string
  onToggle: (next: boolean) => void
  onDismissNotice: () => void
}) {
  if (!status?.available) return null
  const control = editorSshSwitch(status)
  const problem = status.problem ? editorSshProblemWords(status.problem, status.includeLine, status.userConfig) : ''
  return (
    <SettingsGroup title="Editors" icon={Code2} className="devices-group">
      <SettingsRow
        title={TITLE}
        description={control.description}
        control={<Switch checked={control.on} label={TITLE} disabled={busy || control.disabled} onChange={onToggle} />}
      />
      {status.noticePending && (
        <EditorSshNoticeView status={status} busy={busy} onUndo={() => onToggle(false)} onDismiss={onDismissNotice} />
      )}
      {(error || problem) && <p role="alert" className="chat-error devices-note">{error || problem}</p>}
    </SettingsGroup>
  )
}

/** Settings → Devices → Editors. Undo removes only Mousse's line; turning it on adds the line again. */
export function EditorSshSettings() {
  const { status, busy, error, enable, disable, acknowledge } = useEditorSsh()
  return (
    <EditorSshSettingsView
      status={status}
      busy={busy}
      error={error}
      onToggle={(next) => void (next ? enable() : disable())}
      onDismissNotice={() => void acknowledge()}
    />
  )
}

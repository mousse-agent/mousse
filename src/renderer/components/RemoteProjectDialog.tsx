import { useId, useState, type FormEvent } from 'react'
import { Modal } from './ui/Modal'
import '../styles/composer-workspace.css'

/**
 * Asks for the path of a folder on another computer. That computer decides whether the folder
 * can be a project; its refusal is shown here and the dialog stays open for another try.
 */
export function RemoteProjectDialog({ deviceName, recents, onSubmit, onClose }: {
  deviceName: string
  /** Paths of the projects that computer already has. */
  recents: readonly string[]
  /** Resolves with the refusal to show, or nothing once the folder is open. */
  onSubmit: (path: string) => Promise<string | undefined>
  onClose: () => void
}) {
  const id = useId()
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = path.trim()
    if (!value || busy) return
    setBusy(true)
    setError('')
    try {
      const refusal = await onSubmit(value)
      if (refusal) setError(refusal)
      else onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={`Open project on ${deviceName}`}
      onClose={onClose}
      footer={<button type="submit" form={`${id}-form`} className="settings-btn" disabled={busy || !path.trim()}>Open</button>}
    >
      <form id={`${id}-form`} className="remote-project-dialog" onSubmit={(event) => void submit(event)}>
        <label className="remote-project-field">
          <span>Folder on {deviceName}</span>
          <input
            value={path}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="/Users/you/code/app"
            aria-label={`Folder path on ${deviceName}`}
            onChange={(event) => { setPath(event.target.value); setError('') }}
          />
        </label>
        {recents.length > 0 && (
          <div>
            <div className="remote-project-recents-label">On {deviceName}</div>
            <ul className="remote-project-recents">
              {recents.slice(0, 5).map((recent) => (
                <li key={recent}>
                  <button type="button" className="remote-project-recent" title={recent} onClick={() => { setPath(recent); setError('') }}>{recent}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="remote-project-error" role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

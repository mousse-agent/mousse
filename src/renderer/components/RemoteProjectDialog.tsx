import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, Folder } from '../lib/icons'
import type { BrowsedFolders } from '../lib/sourceControl'
import { Modal } from './ui/Modal'
import '../styles/composer-workspace.css'

/**
 * Adds a folder of another computer as a project there: picked by browsing that computer's folders, or by its path.
 * That computer decides whether the folder can be a project; its refusal is shown here and the dialog stays open for
 * another try.
 */
export function RemoteProjectDialog({ deviceName, recents, browse, onSubmit, onClose }: {
  deviceName: string
  /** Paths of the projects that computer already has. */
  recents: readonly string[]
  /** That computer's folders (`folders.browse`): its places without a path, else the folders in it. */
  browse?: (path?: string) => Promise<BrowsedFolders>
  /** Resolves with the refusal to show, or nothing once the folder is open. */
  onSubmit: (path: string) => Promise<string | undefined>
  onClose: () => void
}) {
  const id = useId()
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<BrowsedFolders | null>(null)
  const [browseError, setBrowseError] = useState('')
  const [loading, setLoading] = useState(false)
  // Only the latest folder asked for is shown: a slow answer for one clicked before does not replace it.
  const asked = useRef(0)

  const open = async (folder?: string) => {
    if (!browse) return
    const ask = ++asked.current
    setLoading(true)
    setBrowseError('')
    try {
      const next = await browse(folder)
      if (ask !== asked.current) return
      setView(next)
      if (next.path) {
        setPath(next.path)
        setError('')
      }
    } catch (cause) {
      if (ask !== asked.current) return
      setBrowseError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }

  useEffect(() => {
    void open()
    // Once, from that computer's places.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = path.trim()
    if (!value || busy || loading) return
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
      title={`Add project on ${deviceName}`}
      onClose={onClose}
      footer={<button type="submit" form={`${id}-form`} className="settings-btn" disabled={busy || loading || !path.trim()}>Add</button>}
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
        {browse && (
          <div>
            <div className="remote-project-recents-label">{view?.path ? `In ${view.path}` : `Folders on ${deviceName}`}</div>
            {/* A failed read keeps the folder shown before, so browsing goes on from there. */}
            {browseError && <p className="remote-project-note" role="status">{browseError}</p>}
            {view && (
              <ul className="remote-project-recents remote-project-folders" aria-label={`Folders on ${deviceName}`} aria-busy={loading || undefined}>
                {view?.parent && (
                  <li>
                    <button type="button" className="remote-project-recent remote-project-folder" title={view.parent} onClick={() => void open(view.parent!)}>
                      <ArrowUp size={13} aria-hidden="true" />
                      <span>..</span>
                    </button>
                  </li>
                )}
                {view?.folders.map((folder) => (
                  <li key={folder.path}>
                    <button type="button" className="remote-project-recent remote-project-folder" title={folder.path} onClick={() => void open(folder.path)}>
                      <Folder size={13} aria-hidden="true" />
                      <span>{folder.name}</span>
                    </button>
                  </li>
                ))}
                {view && !loading && view.folders.length === 0 && <li className="remote-project-note">No folders here</li>}
              </ul>
            )}
          </div>
        )}
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

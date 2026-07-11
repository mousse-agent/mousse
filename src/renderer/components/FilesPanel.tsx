import { useCallback, useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { FileTree, FileTreeToolbar } from './FileTree'

export function FilesPanel() {
  const { root: filesRoot, label: rootLabel } = useFilesRoot()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const isDirty = content !== savedContent

  const loadFile = useCallback(async (filePath: string) => {
    setLoading(true)
    setError(null)
    try {
      const text = await window.mousse.fs.readFile(filePath)
      setSelectedPath(filePath)
      setContent(text)
      setSavedContent(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const saveFile = useCallback(async () => {
    if (!selectedPath || !isDirty) return
    setSaving(true)
    setError(null)
    try {
      await window.mousse.fs.writeFile(selectedPath, content)
      setSavedContent(content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [selectedPath, content, isDirty])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void saveFile()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveFile])

  return (
    <div className="files-panel">
      <div className="files-sidebar">
        <div className="panel-toolbar">
          <span className="panel-toolbar-label">Explorer</span>
          <FileTreeToolbar onRefresh={() => setRefreshKey((k) => k + 1)} />
        </div>
        <FileTree
          filesRoot={filesRoot}
          rootLabel={rootLabel}
          selectedPath={selectedPath}
          onSelectFile={(path) => void loadFile(path)}
          refreshKey={refreshKey}
        />
      </div>
      <div className="files-editor">
        <div className="panel-toolbar">
          <span className="panel-toolbar-path" title={selectedPath ?? undefined}>
            {selectedPath ?? 'Select a file'}
          </span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!selectedPath || !isDirty || saving}
            onClick={() => void saveFile()}
          >
            <Save size={14} strokeWidth={2} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <div className="panel-error">{error}</div>}
        {loading ? (
          <div className="files-editor-empty">Loading…</div>
        ) : selectedPath ? (
          <textarea
            className="files-editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <div className="files-editor-empty">
            <p>Select a file from the tree</p>
          </div>
        )}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Monaco } from '@monaco-editor/react'
import { Eye, Pencil, Save } from 'lucide-react'
import { useFilesRoot } from '../hooks/useActiveProjectPath'
import { useAppStore } from '../stores/appStore'
import { isAssetView, isBinaryContent, languageForPath, viewKindForPath } from '../utils/fileEditor'
import { applyEditorTheme, MOUSSE_EDITOR_THEME } from '../utils/monacoTheme'
import { FileTree, FileTreeToolbar } from './FileTree'
import { ResizablePanelSidebar } from './ResizablePanelSidebar'

export function FilesPanel() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const { root: filesRoot, label: rootLabel } = useFilesRoot()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [binary, setBinary] = useState(false)
  const [assetUrl, setAssetUrl] = useState<string | null>(null)
  const [preview, setPreview] = useState(true)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const loadSequence = useRef(0)
  const monacoRef = useRef<Monaco | null>(null)
  const saveFileRef = useRef<() => void>(() => undefined)

  const viewKind = selectedPath ? viewKindForPath(selectedPath) : 'text'
  const supportsModes = viewKind === 'markdown' || viewKind === 'html'
  const isDirty = !binary && !isAssetView(viewKind) && content !== savedContent

  useEffect(() => () => {
    if (assetUrl) URL.revokeObjectURL(assetUrl)
  }, [assetUrl])

  useEffect(() => {
    setSelectedPath(null)
    setContent('')
    setSavedContent('')
    setAssetUrl(null)
    setError(null)
  }, [activeThreadId])

  const loadFile = useCallback(async (filePath: string) => {
    if (filePath === selectedPath) return
    if (isDirty && !window.confirm('Discard unsaved changes and open another file?')) return

    const sequence = ++loadSequence.current
    setLoading(true)
    setError(null)
    try {
      const kind = viewKindForPath(filePath)
      if (isAssetView(kind)) {
        const asset = await window.mousse.fs.readAsset(filePath, undefined, activeThreadId)
        if (sequence !== loadSequence.current) return
        const bytes = Uint8Array.from(asset.data)
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: asset.mimeType }))
        setSelectedPath(filePath)
        setBinary(true)
        setAssetUrl(url)
        setContent('')
        setSavedContent('')
        return
      }
      const text = await window.mousse.fs.readFile(filePath, undefined, activeThreadId)
      if (sequence !== loadSequence.current) return
      const isBinary = isBinaryContent(text)
      setSelectedPath(filePath)
      setBinary(isBinary)
      setContent(isBinary ? '' : text)
      setSavedContent(isBinary ? '' : text)
      setAssetUrl(null)
      setPreview(kind === 'markdown' || kind === 'html')
    } catch (err) {
      if (sequence === loadSequence.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [activeThreadId, isDirty, selectedPath])

  const saveFile = useCallback(async () => {
    if (!selectedPath || !isDirty || saving) return
    setSaving(true)
    setError(null)
    try {
      await window.mousse.fs.writeFile(selectedPath, content, undefined, activeThreadId)
      setSavedContent(content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [selectedPath, content, isDirty, saving, activeThreadId])
  saveFileRef.current = () => void saveFile()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveFile()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveFile])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  useEffect(() => {
    const updateTheme = () => monacoRef.current && applyEditorTheme(monacoRef.current)
    const observer = new MutationObserver(updateTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    const media = window.matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', updateTheme)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', updateTheme)
    }
  }, [])

  const beforeMount: BeforeMount = (monaco) => applyEditorTheme(monaco)
  const onMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco
    applyEditorTheme(monaco)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFileRef.current())
  }

  return (
    <div className="files-panel">
      <ResizablePanelSidebar className="files-sidebar" defaultWidth={260}>
        <div className="panel-toolbar">
          <span className="panel-toolbar-label">Explorer</span>
          <FileTreeToolbar onRefresh={() => setRefreshKey((k) => k + 1)} />
        </div>
        <FileTree
          filesRoot={filesRoot}
          rootLabel={rootLabel}
          threadId={activeThreadId}
          selectedPath={selectedPath}
          onSelectFile={(path) => void loadFile(path)}
          refreshKey={refreshKey}
        />
      </ResizablePanelSidebar>
      <div className="files-editor">
        <div className="panel-toolbar">
          <span className="panel-toolbar-path" title={selectedPath ?? undefined}>
            {selectedPath ? `${selectedPath}${isDirty ? ' •' : ''}` : 'Select a file'}
          </span>
          <div className="files-toolbar-actions">
          {supportsModes && (
            <div className="files-view-toggle" role="group" aria-label="File view">
              <button type="button" className={`btn btn-sm ${!preview ? 'active' : ''}`} onClick={() => setPreview(false)}>
                <Pencil size={13} /> Edit
              </button>
              <button type="button" className={`btn btn-sm ${preview ? 'active' : ''}`} onClick={() => setPreview(true)}>
                <Eye size={13} /> Preview
              </button>
            </div>
          )}
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
        </div>
        {error && <div className="panel-error">{error}</div>}
        {loading ? (
          <div className="files-editor-empty">Loading…</div>
        ) : selectedPath && viewKind === 'pdf' && assetUrl ? (
          <iframe className="files-asset-preview files-pdf-preview" src={assetUrl} title={`PDF preview: ${selectedPath}`} />
        ) : selectedPath && viewKind === 'image' && assetUrl ? (
          <div className="files-asset-preview"><img src={assetUrl} alt={selectedPath} /></div>
        ) : selectedPath && viewKind === 'video' && assetUrl ? (
          <div className="files-asset-preview"><video src={assetUrl} controls /></div>
        ) : selectedPath && binary ? (
          <div className="files-editor-empty">Binary files cannot be edited.</div>
        ) : selectedPath && viewKind === 'markdown' && preview ? (
          <article className="files-text-preview chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{content}</ReactMarkdown></article>
        ) : selectedPath && viewKind === 'html' && preview ? (
          <iframe className="files-asset-preview files-html-preview" srcDoc={content} sandbox="" title={`HTML preview: ${selectedPath}`} />
        ) : selectedPath ? (
          <div className="files-monaco-editor">
            <Editor
              path={selectedPath}
              value={content}
              language={languageForPath(selectedPath)}
              theme={MOUSSE_EDITOR_THEME}
              beforeMount={beforeMount}
              onMount={onMount}
              onChange={(value) => setContent(value ?? '')}
              options={{
                automaticLayout: true,
                bracketPairColorization: { enabled: true },
                matchBrackets: 'always',
                minimap: { enabled: true },
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                fontFamily: "Consolas, 'Courier New', monospace",
                fontSize: 13,
                tabSize: 2,
                detectIndentation: true,
                wordWrap: 'off'
              }}
            />
          </div>
        ) : (
          <div className="files-editor-empty"><p>Select a file from the tree</p></div>
        )}
      </div>
    </div>
  )
}

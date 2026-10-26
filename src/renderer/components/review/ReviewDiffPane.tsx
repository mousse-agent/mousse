import { useEffect, useRef, useState } from 'react'
import { DiffEditor, type BeforeMount, type DiffOnMount, type Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { ReviewFileResult, ReviewFileSide, ReviewScope } from '../../../shared/review'
import { useAppStore } from '../../stores/appStore'
import { CODE_FONT } from '../../lib/typography'
import { applyEditorTheme, MOUSSE_EDITOR_THEME } from '../../utils/monacoTheme'
import { languageForPath } from '../../utils/fileEditor'
import { isPlaceholderSide, placeholderFor, viewChangeLabel } from './reviewModel'

export interface ReviewDiffTarget {
  threadId?: string
  projectId?: string
  scope: ReviewScope
}

export interface ReviewDiffPaneProps {
  target: ReviewDiffTarget
  path: string | null
  /** The original name of a renamed file, so the left side is read at its old path. */
  oldPath?: string
  /** Changes when the file list was reloaded: the open file is re-read in place, without a loading state. */
  version?: number
  ignoreWhitespace: boolean
  /** Saved Monaco view state for the file; applied when the file opens. */
  viewState?: unknown
  /** Called with the file's view state when the file is closed or replaced. */
  onSaveViewState?: (path: string, state: unknown) => void
  onMount?: (diffEditor: editor.IStandaloneDiffEditor, result: ReviewFileResult) => void
  emptyLabel?: string
}

const textOf = (side: ReviewFileSide): string => (side && 'content' in side ? side.content : '')

/** The whitespace switch shared by the Review and Git toolbars. It changes highlighting only. */
export function WhitespaceToggle() {
  const ignore = useAppStore((s) => s.reviewIgnoreWhitespace)
  const setIgnore = useAppStore((s) => s.setReviewIgnoreWhitespace)
  return (
    <label className="review-toggle" title="Changes the highlighting only; counts stay the same.">
      <input type="checkbox" checked={ignore} onChange={(event) => setIgnore(event.target.checked)} />
      Ignore leading/trailing whitespace
    </label>
  )
}

function Placeholders({ original, modified }: { original: ReviewFileSide; modified: ReviewFileSide }) {
  const status = original === null ? 'added' : modified === null ? 'deleted' : 'modified'
  const left = placeholderFor(original, status) ?? 'Not shown'
  const right = placeholderFor(modified, status) ?? 'Not shown'
  const tooLarge = [original, modified].some((side) => side !== null && 'tooLarge' in side)
  return (
    <div className="review-placeholder">
      {left === right ? (
        <div className="review-placeholder-text">{left}</div>
      ) : (
        <div className="review-placeholder-sides">
          <div className="review-placeholder-side">
            <span className="review-placeholder-title">Before</span>
            <span className="review-placeholder-text">{left}</span>
          </div>
          <div className="review-placeholder-side">
            <span className="review-placeholder-title">After</span>
            <span className="review-placeholder-text">{right}</span>
          </div>
        </div>
      )}
      {tooLarge && <div className="review-placeholder-note">Counts include all changes.</div>}
    </div>
  )
}

/** One file's old and new contents as a full-file Monaco diff, with placeholders for binary and oversized files. */
export function ReviewDiffPane({
  target,
  path,
  oldPath,
  version = 0,
  ignoreWhitespace,
  viewState,
  onSaveViewState,
  onMount,
  emptyLabel = 'Select a changed file to view its diff'
}: ReviewDiffPaneProps) {
  const { threadId, projectId, scope } = target
  const scopeJson = JSON.stringify(scope)
  const key = `${threadId ?? ''}\0${projectId ?? ''}\0${scopeJson}\0${path ?? ''}\0${oldPath ?? ''}`
  const [loaded, setLoaded] = useState<{ key: string; result: ReviewFileResult } | null>(null)
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [changeLabel, setChangeLabel] = useState<string | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const latestViewState = useRef<unknown>(null)
  const viewStateRef = useRef(viewState)
  viewStateRef.current = viewState
  const saveRef = useRef(onSaveViewState)
  saveRef.current = onSaveViewState
  const mountRef = useRef(onMount)
  mountRef.current = onMount
  const resultRef = useRef<ReviewFileResult | null>(null)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    window.mousse.review
      .file({ threadId, projectId, scope: JSON.parse(scopeJson) as ReviewScope, path, oldPath })
      .then((result) => {
        if (cancelled) return
        setLoaded({ key, result })
        setFailed(null)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailed({ key, message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
    // `key` is derived from the other dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, projectId, scopeJson, path, oldPath, version, retry])

  // The editor is remounted per file, so its view state is captured as the user scrolls and handed to
  // the store when the file is replaced or the pane closes (the editor is already disposed by then).
  useEffect(() => {
    if (!path) return
    const savedPath = path
    return () => {
      const state = latestViewState.current
      latestViewState.current = null
      if (state) saveRef.current?.(savedPath, state)
    }
  }, [key, path])

  useEffect(() => setChangeLabel(null), [key])

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

  const current = loaded?.key === key ? loaded.result : null
  resultRef.current = current
  const error = failed?.key === key ? failed.message : null

  const beforeMount: BeforeMount = (monaco) => applyEditorTheme(monaco)
  const handleMount: DiffOnMount = (diffEditor, monaco) => {
    monacoRef.current = monaco
    applyEditorTheme(monaco)
    const saved = viewStateRef.current
    if (saved) {
      try {
        diffEditor.restoreViewState(saved as editor.IDiffEditorViewState)
      } catch {
        // A stale view state from another version of the file is ignored.
      }
    }
    const capture = () => {
      latestViewState.current = diffEditor.saveViewState()
    }
    diffEditor.getModifiedEditor().onDidScrollChange(capture)
    diffEditor.getOriginalEditor().onDidScrollChange(capture)
    diffEditor.getModifiedEditor().onDidChangeCursorPosition(capture)
    diffEditor.onDidUpdateDiff(() => setChangeLabel(viewChangeLabel(diffEditor.getLineChanges())))
    if (resultRef.current) mountRef.current?.(diffEditor, resultRef.current)
  }

  if (!path) {
    return (
      <div className="review-diff">
        <div className="git-diff-empty">{emptyLabel}</div>
      </div>
    )
  }

  const renderBody = () => {
    if (error && !current) {
      return (
        <div className="git-diff-empty review-diff-error" role="alert">
          <span>Could not load diff: {error}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setFailed(null)
              setRetry((value) => value + 1)
            }}
          >
            Retry
          </button>
        </div>
      )
    }
    if (!current) return <div className="git-diff-empty">Loading diff…</div>
    const { original, modified } = current
    if (isPlaceholderSide(original) || isPlaceholderSide(modified) || (original === null && modified === null)) {
      return <Placeholders original={original} modified={modified} />
    }
    return (
      <div className="git-diff-content">
        <DiffEditor
          key={key}
          original={textOf(original)}
          modified={textOf(modified)}
          language={languageForPath(path)}
          theme={MOUSSE_EDITOR_THEME}
          beforeMount={beforeMount}
          onMount={handleMount}
          options={{
            automaticLayout: true,
            readOnly: true,
            originalEditable: false,
            ignoreTrimWhitespace: ignoreWhitespace,
            renderSideBySide: true,
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            folding: true,
            renderWhitespace: 'selection',
            wordWrap: 'off',
            fontFamily: CODE_FONT,
            fontSize: 12
          }}
        />
      </div>
    )
  }

  return (
    <div className="review-diff">
      <div className="review-diff-header">
        <span className="review-diff-path" title={oldPath ? `${oldPath} → ${path}` : path}>
          {oldPath ? `${oldPath} → ${path}` : path}
        </span>
        {changeLabel && current && !isPlaceholderSide(current.original) && !isPlaceholderSide(current.modified) && (
          <span className="review-diff-changes">{changeLabel}</span>
        )}
      </div>
      {renderBody()}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, type BeforeMount, type DiffOnMount, type Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { MessageSquare } from '../../lib/icons'
import { createReviewComment, joinReviewPath, REVIEW_EXCERPT_MAX_LINES, type ChatReference } from '../../../shared/chatReferences'
import type { ReviewFileResult, ReviewFileSide, ReviewScope } from '../../../shared/review'
import { useAppStore } from '../../stores/appStore'
import { useReviewStore } from '../../stores/reviewStore'
import { CODE_FONT } from '../../lib/typography'
import { applyEditorTheme, MOUSSE_EDITOR_THEME } from '../../utils/monacoTheme'
import { languageForPath } from '../../utils/fileEditor'
import { commentDecorations, commentScopeLabel, commentsForFile, scopeKey, selectedLineRange } from './reviewComments'
import { isPlaceholderSide, placeholderFor, viewChangeLabel } from './reviewModel'

const NO_REFERENCES: ChatReference[] = []

interface CommentForm {
  /** The file and version the form was opened on; it is not shown for another one. */
  key: string
  line: number
  endLine: number
}

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
  /** How the version is named to the agent and on the pill; defaults to a name derived from the scope. */
  scopeLabel?: string
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
  scopeLabel,
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
  // Monaco's onMount runs from the first render of the editor, so what it needs is read through refs.
  const keyRef = useRef(key)
  keyRef.current = key
  const commentsRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const hoverRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const hoverLine = useRef(0)
  const [modifiedEditor, setModifiedEditor] = useState<{ key: string; editor: editor.ICodeEditor } | null>(null)
  const [selection, setSelection] = useState<{ key: string; line: number; endLine: number } | null>(null)
  const [form, setForm] = useState<CommentForm | null>(null)
  const [draft, setDraft] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const composerThreadId = useAppStore((s) => s.activeThreadId)
  const references = useAppStore((s) => s.composerReferences[s.activeThreadId ?? '__blank__'] ?? NO_REFERENCES)
  const platform = useAppStore((s) => s.appInfo?.platform ?? '')
  const pendingReveal = useReviewStore((s) => (threadId ? s.byThread[threadId]?.reveal : undefined))

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

  const reviewScope = scopeKey(scope)
  const absolutePath = current ? joinReviewPath(current.root, current.path) : null
  const fileComments = useMemo(
    () => (absolutePath ? commentsForFile(references, { reviewScope, absolutePath, platform }) : []),
    [references, reviewScope, absolutePath, platform]
  )
  const activeEditor = modifiedEditor?.key === key ? modifiedEditor.editor : null
  // A deleted file has no modified side to comment on.
  const canComment = current !== null && current.modified !== null
  const activeSelection = selection?.key === key ? selection : null
  const activeForm = form?.key === key ? form : null

  // Marks follow the composer's references, so removing a pill removes its mark and sending clears them all.
  useEffect(() => {
    if (!activeEditor?.getModel()) return
    commentsRef.current?.set(commentDecorations(fileComments))
  }, [activeEditor, fileComments, current])

  // A comment pill that was clicked: scroll to its line once the file is open.
  useEffect(() => {
    const model = activeEditor?.getModel()
    if (!activeEditor || !model || !threadId || !path || !pendingReveal || !current) return
    const taken = useReviewStore.getState().takeReveal(threadId, path)
    if (!taken) return
    const line = Math.min(taken.line, model.getLineCount())
    activeEditor.revealLineInCenter(line)
    activeEditor.setPosition({ lineNumber: line, column: 1 })
  }, [activeEditor, threadId, path, pendingReveal, current])

  const openForm = (line: number, endLine: number) => {
    setForm({ key: keyRef.current, line, endLine })
    setDraft('')
    setFormError(null)
  }
  const closeForm = () => {
    setForm(null)
    setDraft('')
    setFormError(null)
  }
  const addComment = () => {
    const model = activeEditor?.getModel()
    const text = draft.trim()
    if (!activeForm || !current || !model || !text) return
    const last = Math.min(activeForm.endLine, model.getLineCount())
    const first = Math.min(activeForm.line, last)
    // Only the lines an excerpt can keep are read, so a comment on a huge range stays cheap.
    const excerptEnd = Math.min(last, first + REVIEW_EXCERPT_MAX_LINES)
    const excerpt = model.getValueInRange({ startLineNumber: first, startColumn: 1, endLineNumber: excerptEnd, endColumn: model.getLineMaxColumn(excerptEnd) })
    try {
      const reference = createReviewComment({
        root: current.root,
        path: current.path,
        line: first,
        endLine: last,
        comment: text,
        excerpt,
        reviewScope,
        scopeLabel: scopeLabel ?? commentScopeLabel(scope)
      })
      const store = useAppStore.getState()
      store.addComposerReference(composerThreadId, reference)
      // The composer drops a reference it cannot parse without saying so.
      if (!useAppStore.getState().composerReferences[composerThreadId ?? '__blank__']?.some((item) => item.id === reference.id)) {
        setFormError('Could not add this comment.')
        return
      }
      closeForm()
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const options = useMemo<editor.IDiffEditorConstructionOptions>(
    () => ({
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      ignoreTrimWhitespace: ignoreWhitespace,
      renderSideBySide: true,
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: true,
      scrollBeyondLastLine: false,
      folding: true,
      renderWhitespace: 'selection',
      wordWrap: 'off',
      fontFamily: CODE_FONT,
      fontSize: 12
    }),
    [ignoreWhitespace]
  )

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

    const modified = diffEditor.getModifiedEditor()
    const mountedKey = keyRef.current
    commentsRef.current = modified.createDecorationsCollection()
    hoverRef.current = modified.createDecorationsCollection()
    hoverLine.current = 0
    modified.onDidChangeCursorSelection((event) => {
      const range = selectedLineRange(event.selection)
      setSelection((previous) =>
        range === null
          ? previous === null ? previous : null
          : previous?.key === mountedKey && previous.line === range.line && previous.endLine === range.endLine
            ? previous
            : { key: mountedKey, ...range }
      )
    })
    // A click on the gutter's glyph column comments on that line, or on the selection when it covers the line.
    modified.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.target.position) return
      if (!resultRef.current?.modified) return
      const line = event.target.position.lineNumber
      const cursor = modified.getSelection()
      const selected = cursor ? selectedLineRange(cursor) : null
      if (selected && line >= selected.line && line <= selected.endLine) openForm(selected.line, selected.endLine)
      else openForm(line, line)
    })
    // The gutter shows where a click adds a comment.
    modified.onMouseMove((event) => {
      const type = event.target.type
      const onGutter = type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
      const line = onGutter && resultRef.current?.modified && event.target.position ? event.target.position.lineNumber : 0
      if (line === hoverLine.current) return
      hoverLine.current = line
      hoverRef.current?.set(
        line ? [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { glyphMarginClassName: 'review-comment-add-glyph' } }] : []
      )
    })
    modified.onMouseLeave(() => {
      hoverLine.current = 0
      hoverRef.current?.clear()
    })
    modified.onDidDispose(() => setModifiedEditor((previous) => (previous?.editor === modified ? null : previous)))
    setModifiedEditor({ key: mountedKey, editor: modified })

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
          options={options}
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
        {canComment && current && !isPlaceholderSide(current.modified) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm review-comment-button"
            disabled={!activeSelection}
            onClick={() => activeSelection && openForm(activeSelection.line, activeSelection.endLine)}
            title={activeSelection ? 'Comment on the selected lines' : 'Select lines on the right, or click the gutter, to comment'}
          >
            <MessageSquare size={14} strokeWidth={2} />
            Comment
          </button>
        )}
      </div>
      {activeForm && (
        <div className="review-comment-form">
          <div className="review-comment-form-title">
            {activeForm.endLine > activeForm.line ? `Lines ${activeForm.line}–${activeForm.endLine}` : `Line ${activeForm.line}`}
          </div>
          <textarea
            className="review-comment-input"
            autoFocus
            rows={3}
            value={draft}
            placeholder="Comment for the agent"
            aria-label="Comment for the agent"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeForm()
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                addComment()
              }
            }}
          />
          {formError && <div className="review-comment-form-error" role="alert">{formError}</div>}
          <div className="review-comment-form-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={closeForm}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={addComment}>Add</button>
          </div>
        </div>
      )}
      {renderBody()}
    </div>
  )
}

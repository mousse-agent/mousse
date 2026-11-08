import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import { parseDiffFromFile, type DiffLineAnnotation, type SelectedLineRange } from '@pierre/diffs'
import { MessageSquare, Undo2 } from '../../lib/icons'
import { createReviewComment, joinReviewPath, REVIEW_EXCERPT_MAX_LINES, type ChatReference } from '../../../shared/chatReferences'
import type { ReviewFileResult, ReviewFileSide, ReviewScope } from '../../../shared/review'
import { useAppStore } from '../../stores/appStore'
import { useChangesStore } from '../../stores/changesStore'
import { diffSurfaceStyle, diffUnsafeCSS, useDiffThemeType } from '../../lib/diffTheme'
import { DelayedLoader } from '../ui/DelayedLoader'
import { commentsForFile } from '../review/reviewComments'
import { isPlaceholderSide, placeholderFor } from '../review/reviewModel'
import { commentTarget, contentHash, hunkAnchor, hunkAtLine, hunksFromMetadata, type HunkRange } from './changesModel'
import type { IncludeState } from './changesApi'

const NO_REFERENCES: ChatReference[] = []

export interface DiffTarget {
  threadId?: string
  projectId?: string
  scope: ReviewScope
}

/** What a hunk's hover bar can do here; Include and Revert only where the scope and the daemon allow. */
export interface HunkActions {
  canRevert: boolean
  /** Revert would be allowed here but is off for now (a turn runs, whitespace is ignored): the reason, shown on a disabled button. */
  revertOff: string | null
  /** The Include checkboxes show: every hunk carries one, not only the hovered or focused one. */
  canInclude: boolean
  /** The hunk's include state from the daemon, or null when it is not known. */
  includedOf: (hunk: HunkRange) => IncludeState | null
  onRevert: (hunk: HunkRange) => void
  onInclude: (hunk: HunkRange, include: boolean) => void
}

/** A line range on one side: `deletions` is the file before the change. */
export interface LineRange {
  side: 'additions' | 'deletions'
  start: number
  end: number
}

type Annotation =
  | { kind: 'comment'; reference: ChatReference }
  | { kind: 'form' }
  | { kind: 'hunk'; hunk: HunkRange }
  | { kind: 'include'; hunk: HunkRange }
  | { kind: 'reveal' }

export interface ChangesDiffProps {
  target: DiffTarget
  path: string
  oldPath?: string
  /** Changes when the list was re-read: the open file is read again in place, without a loading state. */
  version: number
  ignoreWhitespace: boolean
  split: boolean
  /** How the version is named to the agent and on the pill. */
  scopeLabel: string
  /** `scopeKey` of the scope, which comments carry. */
  reviewScope: string
  focusedHunk: number | null
  onFocusHunk: (index: number | null) => void
  onHunks: (hunks: HunkRange[]) => void
  /** A hash of both sides once read, so a viewed mark follows the file's contents. */
  onContent: (hash: string | null) => void
  /** Bumped by the `C` key: comment on the selected lines, else the focused hunk. */
  commentRequest: number
  /** The lines selected in the diff, read by Space to include part of a hunk. */
  selectionRef: MutableRefObject<LineRange | null>
  actions: HunkActions
}

const textOf = (side: ReviewFileSide): string => (side && 'content' in side ? side.content : '')

function Placeholder({ result }: { result: ReviewFileResult }) {
  const status = result.original === null ? 'added' : result.modified === null ? 'deleted' : 'modified'
  const text = placeholderFor(isPlaceholderSide(result.modified) ? result.modified : result.original, status) ?? 'Not shown'
  return <div className="changes-card-note">{text}</div>
}

/**
 * Code reads as typed: no ligatures (`===`, `=>`, `>=`, `...` stay separate characters). In the unified view a
 * removed line's number is left out of the one-column gutter so the numbers read in order (its red marker stays).
 */
const NO_LIGATURES = `
:host, [data-diff], [data-file], [data-code], [data-line], [data-column-number] {
  --diffs-font-features: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "calt" 0;
}
`
const UNIFIED_GUTTER = `
[data-diff-type='single'] [data-column-number][data-line-type='change-deletion'] [data-line-number-content] {
  visibility: hidden;
}
`

const rangeOf = (range: SelectedLineRange): LineRange => ({
  side: range.side === 'deletions' ? 'deletions' : 'additions',
  start: Math.min(range.start, range.end),
  end: Math.max(range.start, range.end)
})

/**
 * One file's diff in its open card: unified hunks with 3 context lines (Split when there is room), comments on
 * either side through the gutter or a line selection, and a bar on the hovered or focused hunk with Comment,
 * Include and Revert.
 */
export function ChangesDiff({
  target,
  path,
  oldPath,
  version,
  ignoreWhitespace,
  split,
  scopeLabel,
  reviewScope,
  focusedHunk,
  onFocusHunk,
  onHunks,
  onContent,
  commentRequest,
  selectionRef,
  actions
}: ChangesDiffProps) {
  const { threadId, projectId, scope } = target
  const scopeJson = JSON.stringify(scope)
  const key = `${threadId ?? ''}\0${projectId ?? ''}\0${scopeJson}\0${path}\0${oldPath ?? ''}`
  const [loaded, setLoaded] = useState<{ key: string; result: ReviewFileResult } | null>(null)
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [hovered, setHovered] = useState<number | null>(null)
  /** The line under the pointer, which `C` and a hunk's Comment button comment on. */
  const hoveredLine = useRef<{ side: 'additions' | 'deletions'; line: number } | null>(null)
  const [form, setForm] = useState<{ key: string; range: LineRange } | null>(null)
  const [draft, setDraft] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const themeType = useDiffThemeType()
  const composerThreadId = useAppStore((s) => s.activeThreadId)
  const references = useAppStore((s) => s.composerReferences[s.activeThreadId ?? '__blank__'] ?? NO_REFERENCES)
  const platform = useAppStore((s) => s.appInfo?.platform ?? '')
  const pendingReveal = useChangesStore((s) => (threadId ? s.byThread[threadId]?.reveal : undefined))

  useEffect(() => {
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

  const current = loaded?.key === key ? loaded.result : null
  const error = failed?.key === key ? failed.message : null
  const placeholder = current !== null && (isPlaceholderSide(current.original) || isPlaceholderSide(current.modified))
  const oldText = current ? textOf(current.original) : ''
  const newText = current ? textOf(current.modified) : ''

  const metadata = useMemo(() => {
    if (!current || placeholder) return null
    return parseDiffFromFile(
      current.original === null ? null : { name: oldPath ?? path, contents: oldText },
      current.modified === null ? null : { name: path, contents: newText },
      { context: 3, ignoreWhitespace }
    )
  }, [current, placeholder, oldPath, path, oldText, newText, ignoreWhitespace])
  const hunks = useMemo(() => (metadata ? hunksFromMetadata(metadata) : []), [metadata])

  const onHunksRef = useRef(onHunks)
  onHunksRef.current = onHunks
  useEffect(() => onHunksRef.current(hunks), [hunks])
  const onContentRef = useRef(onContent)
  onContentRef.current = onContent
  useEffect(() => onContentRef.current(current ? contentHash(oldText, newText) : null), [current, oldText, newText])

  const absolutePath = current ? joinReviewPath(current.root, current.path) : null
  const fileComments = useMemo(
    () => (absolutePath ? commentsForFile(references, { reviewScope, absolutePath, platform }) : []),
    [references, reviewScope, absolutePath, platform]
  )

  const activeForm = form?.key === key ? form : null
  const openForm = useCallback((range: LineRange) => {
    setForm({ key, range })
    setDraft('')
    setFormError(null)
  }, [key])
  const closeForm = () => {
    setForm(null)
    setDraft('')
    setFormError(null)
  }

  /** The selected lines, else the hovered line, else the hunk's first changed line. */
  const commentOn = useCallback(
    (hunk: HunkRange | null) => {
      const range = commentTarget({ selection: selectionRef.current, hovered: hoveredLine.current, hunk, hunks })
      if (range) openForm(range)
    },
    [hunks, openForm, selectionRef]
  )

  // `C`: the selected lines, else the hovered line, else the focused hunk's first changed line.
  const lastRequest = useRef(commentRequest)
  useEffect(() => {
    if (commentRequest === lastRequest.current) return
    lastRequest.current = commentRequest
    commentOn(focusedHunk !== null ? hunks[focusedHunk] ?? null : null)
  }, [commentRequest, focusedHunk, hunks, commentOn])

  const addComment = () => {
    const text = draft.trim()
    if (!activeForm || !current || !text || !metadata) return
    const { side, start, end } = activeForm.range
    const lines = side === 'deletions' ? metadata.deletionLines : metadata.additionLines
    const excerpt = lines.slice(start - 1, Math.min(end, start - 1 + REVIEW_EXCERPT_MAX_LINES)).join('\n').replace(/\r?\n$/, '')
    try {
      const reference = createReviewComment({
        root: current.root,
        path: side === 'deletions' && oldPath ? oldPath : current.path,
        line: start,
        endLine: end,
        comment: text,
        excerpt,
        reviewScope,
        scopeLabel,
        ...(side === 'deletions' ? { side: 'old' as const } : {})
      })
      useAppStore.getState().addComposerReference(composerThreadId, reference)
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

  // A comment pill that was clicked: mark its line and scroll to it once the file is drawn.
  const reveal = threadId && pendingReveal?.path === path && metadata ? pendingReveal : null

  const barHunk = focusedHunk !== null ? hunks[focusedHunk] : hovered !== null ? hunks[hovered] : undefined
  const annotations = useMemo(() => {
    const list: DiffLineAnnotation<Annotation>[] = []
    for (const reference of fileComments) {
      const line = reference.endLine ?? reference.line ?? 0
      list.push({ side: reference.side === 'old' ? 'deletions' : 'additions', lineNumber: line, metadata: { kind: 'comment', reference } })
    }
    if (activeForm) list.push({ side: activeForm.range.side, lineNumber: activeForm.range.end, metadata: { kind: 'form' } })
    if (barHunk && !activeForm) list.push({ ...hunkAnchor(barHunk), metadata: { kind: 'hunk', hunk: barHunk } })
    // While choosing, every other hunk shows its Include box too, so what is left out reads at a glance.
    if (actions.canInclude) {
      for (const hunk of hunks) {
        if (hunk === barHunk && !activeForm) continue
        list.push({ ...hunkAnchor(hunk), metadata: { kind: 'include', hunk } })
      }
    }
    if (reveal) list.push({ side: 'additions', lineNumber: reveal.line, metadata: { kind: 'reveal' } })
    return list
  }, [fileComments, activeForm, barHunk, reveal, actions.canInclude, hunks])

  const hunksRef = useRef(hunks)
  hunksRef.current = hunks
  const openFormRef = useRef(openForm)
  openFormRef.current = openForm
  const options = useMemo(
    () => ({
      theme: { dark: 'github-dark', light: 'github-light' } as const,
      themeType,
      unsafeCSS: diffUnsafeCSS(themeType) + NO_LIGATURES + (split ? '' : UNIFIED_GUTTER),
      diffStyle: split ? ('split' as const) : ('unified' as const),
      disableFileHeader: true,
      hunkSeparators: 'line-info' as const,
      expansionLineCount: 20,
      lineDiffType: 'word-alt' as const,
      overflow: 'scroll' as const,
      enableGutterUtility: true,
      onGutterUtilityClick: (range: SelectedLineRange) => openFormRef.current(rangeOf(range)),
      enableLineSelection: true,
      onLineSelected: (range: SelectedLineRange | null) => {
        selectionRef.current = range ? rangeOf(range) : null
      },
      onLineEnter: ({ lineNumber, annotationSide }: { lineNumber: number; annotationSide: 'additions' | 'deletions' }) => {
        hoveredLine.current = { side: annotationSide, line: lineNumber }
        const hunk = hunkAtLine(hunksRef.current, annotationSide, lineNumber)
        if (hunk) setHovered(hunk.index)
      }
    }),
    [themeType, split, selectionRef]
  )
  const style = useMemo(() => diffSurfaceStyle(themeType), [themeType])

  const renderAnnotation = (annotation: DiffLineAnnotation<Annotation>) => {
    const data = annotation.metadata
    if (data.kind === 'reveal') {
      return (
        <span
          className="changes-reveal"
          ref={(element) => {
            if (!element || !threadId) return
            element.scrollIntoView({ block: 'center' })
            useChangesStore.getState().takeReveal(threadId, path)
          }}
        />
      )
    }
    if (data.kind === 'comment') {
      return (
        <div className="changes-comment" title={data.reference.title}>
          <MessageSquare size={12} strokeWidth={2} aria-hidden="true" />
          <span>{data.reference.comment}</span>
        </div>
      )
    }
    const includeBox = (hunk: HunkRange) => {
      const included = actions.canInclude ? actions.includedOf(hunk) : null
      if (included === null) return null
      return (
        <label className="changes-include" data-included={included} title="Include in the commit (Space)">
          <input
            type="checkbox"
            checked={included === 'yes'}
            ref={(element) => {
              if (element) element.indeterminate = included === 'partial'
            }}
            onChange={(event) => actions.onInclude(hunk, event.target.checked)}
          />
          <span>{included === 'no' ? 'Left out' : 'Include'}</span>
        </label>
      )
    }
    if (data.kind === 'include') {
      return <div className="changes-hunk-bar" data-quiet="true">{includeBox(data.hunk)}</div>
    }
    if (data.kind === 'hunk') {
      const hunk = data.hunk
      return (
        <div className="changes-hunk-bar" role="toolbar" aria-label="Hunk actions">
          {includeBox(hunk)}
          <button type="button" className="changes-bar-btn" title="Comment (C)" onClick={() => commentOn(hunk)}>
            <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
            <span>Comment</span>
          </button>
          {(actions.canRevert || actions.revertOff) && (
            <button
              type="button"
              className="changes-bar-btn"
              title={actions.revertOff ?? 'Revert this hunk (X)'}
              disabled={!actions.canRevert}
              onClick={() => actions.onRevert(hunk)}
            >
              <Undo2 size={13} strokeWidth={2} aria-hidden="true" />
              <span>Revert</span>
            </button>
          )}
        </div>
      )
    }
    const range = activeForm?.range
    return (
      <div className="changes-comment-form">
        <textarea
          className="changes-comment-input"
          autoFocus
          rows={2}
          value={draft}
          placeholder={range && range.end > range.start ? `Comment on lines ${range.start}–${range.end}` : `Comment on line ${range?.start ?? ''}`}
          aria-label="Comment for the agent"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeForm()
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              event.stopPropagation()
              addComment()
            }
          }}
        />
        {formError && <div className="changes-comment-error" role="alert">{formError}</div>}
        <div className="changes-comment-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={closeForm}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={addComment}>Comment</button>
        </div>
      </div>
    )
  }

  if (error && !current) {
    return (
      <div className="changes-card-note" role="alert">
        <span title={error}>Couldn't load this diff</span>
        <button type="button" className="changes-link" onClick={() => { setFailed(null); setRetry((value) => value + 1) }}>Retry</button>
      </div>
    )
  }
  if (!current) return <div className="changes-card-note"><DelayedLoader size="small" label="Loading diff" /></div>
  if (placeholder || !metadata) return <Placeholder result={current} />
  if (hunks.length === 0) return <div className="changes-card-note">{ignoreWhitespace ? 'Only whitespace changed' : 'No changed lines'}</div>

  return (
    <div
      className="changes-diff"
      onMouseLeave={() => {
        setHovered(null)
        hoveredLine.current = null
      }}
      onFocus={() => { if (focusedHunk === null && hovered !== null) onFocusHunk(hovered) }}
    >
      <FileDiff
        key={themeType}
        fileDiff={metadata}
        options={options}
        style={style}
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
        selectedLines={reveal ? { start: reveal.line, end: reveal.line, side: 'additions' } : undefined}
      />
    </div>
  )
}

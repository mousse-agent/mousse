import { Eye, Pencil } from '../../lib/icons'
import type { KeyboardEvent } from 'react'
import type { MarkdownEditorViewMode } from './markdownEditorState'

export interface MarkdownViewTabsProps {
  viewMode: MarkdownEditorViewMode
  sourceTabId: string
  previewTabId: string
  sourcePanelId: string
  previewPanelId: string
  onViewModeChange: (mode: MarkdownEditorViewMode) => void
}

export function MarkdownViewTabs({
  viewMode,
  sourceTabId,
  previewTabId,
  sourcePanelId,
  previewPanelId,
  onViewModeChange
}: MarkdownViewTabsProps) {
  const isPreview = viewMode === 'preview'
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 'source'
      : event.key === 'End'
        ? 'preview'
        : isPreview ? 'source' : 'preview'
    onViewModeChange(next)
    const nextId = next === 'source' ? sourceTabId : previewTabId
    event.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(nextId)}`)?.focus()
  }

  return (
    <div
      className="files-view-toggle"
      role="tablist"
      aria-label="Markdown view"
      onKeyDown={onKeyDown}
      style={{ alignSelf: 'flex-start', margin: '8px 12px 0' }}
    >
      <button
        type="button"
        id={sourceTabId}
        role="tab"
        aria-selected={!isPreview}
        aria-controls={sourcePanelId}
        tabIndex={isPreview ? -1 : 0}
        className={`btn btn-sm ${!isPreview ? 'active' : ''}`}
        onClick={() => onViewModeChange('source')}
      >
        <Pencil size={13} /> Source
      </button>
      <button
        type="button"
        id={previewTabId}
        role="tab"
        aria-selected={isPreview}
        aria-controls={previewPanelId}
        tabIndex={isPreview ? 0 : -1}
        className={`btn btn-sm ${isPreview ? 'active' : ''}`}
        onClick={() => onViewModeChange('preview')}
      >
        <Eye size={13} /> Preview
      </button>
    </div>
  )
}

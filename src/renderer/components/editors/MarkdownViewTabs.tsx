import { Eye, Pencil } from 'lucide-react'
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
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    onViewModeChange(isPreview ? 'source' : 'preview')
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
        tabIndex={isPreview ? -1 : 0}
        className={`btn btn-sm ${isPreview ? 'active' : ''}`}
        onClick={() => onViewModeChange('preview')}
      >
        <Eye size={13} /> Preview
      </button>
    </div>
  )
}

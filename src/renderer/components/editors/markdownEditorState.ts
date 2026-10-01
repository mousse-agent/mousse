export type MarkdownEditorViewMode = 'source' | 'preview'

export interface MarkdownEditorSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface MarkdownValidationMessage {
  id?: string
  severity: 'error' | 'warning' | 'info'
  message: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
}

export interface MarkdownVariableSuggestion {
  name: string
  insertText?: string
  detail?: string
}

export interface MarkdownViewSwitchState {
  value: string
  viewMode: MarkdownEditorViewMode
  selection: MarkdownEditorSelection | null
}

export const DEFAULT_MARKDOWN_SELECTION: MarkdownEditorSelection = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 1
}

export function isMarkdownEditorViewMode(value: unknown): value is MarkdownEditorViewMode {
  return value === 'source' || value === 'preview'
}

/**
 * Switching Source/Preview must keep document bytes and the last Monaco selection.
 * The editor remains mounted; this snapshot is the testable contract for restore.
 */
export function switchMarkdownViewMode(
  state: MarkdownViewSwitchState,
  nextViewMode: MarkdownEditorViewMode
): MarkdownViewSwitchState {
  return {
    value: state.value,
    viewMode: nextViewMode,
    selection: state.selection
  }
}

export function restoreMarkdownSelection(
  selection: MarkdownEditorSelection | null | undefined
): MarkdownEditorSelection {
  if (!selection) return { ...DEFAULT_MARKDOWN_SELECTION }
  return {
    startLineNumber: Math.max(1, selection.startLineNumber),
    startColumn: Math.max(1, selection.startColumn),
    endLineNumber: Math.max(1, selection.endLineNumber),
    endColumn: Math.max(1, selection.endColumn)
  }
}

export function variableCompletionInsertText(suggestion: MarkdownVariableSuggestion): string {
  return suggestion.insertText ?? `{{${suggestion.name}}}`
}

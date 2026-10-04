import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor, IDisposable, languages } from 'monaco-editor'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { applyEditorTheme, MOUSSE_EDITOR_THEME } from '../../utils/monacoTheme'
import { CODE_FONT } from '../../lib/typography'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownViewTabs } from './MarkdownViewTabs'
import {
  isMarkdownEditorViewMode,
  restoreMarkdownSelection,
  variableCompletionInsertText,
  type MarkdownEditorSelection,
  type MarkdownEditorViewMode,
  type MarkdownValidationMessage,
  type MarkdownVariableSuggestion
} from './markdownEditorState'

export interface MarkdownDocumentEditorProps {
  value: string
  onChange?: (value: string) => void
  onSave?: () => void
  readOnly?: boolean
  path?: string
  viewMode?: MarkdownEditorViewMode
  defaultViewMode?: MarkdownEditorViewMode
  onViewModeChange?: (mode: MarkdownEditorViewMode) => void
  validationMessages?: MarkdownValidationMessage[]
  variableSuggestions?: MarkdownVariableSuggestion[]
  autoFocus?: boolean
  className?: string
  'aria-label'?: string
}

type MonacoEditor = editor.IStandaloneCodeEditor

function severityToMonaco(
  monaco: Monaco,
  severity: MarkdownValidationMessage['severity']
): number {
  if (severity === 'error') return monaco.MarkerSeverity.Error
  if (severity === 'warning') return monaco.MarkerSeverity.Warning
  return monaco.MarkerSeverity.Info
}

export function MarkdownDocumentEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  path = 'document.md',
  viewMode,
  defaultViewMode = 'source',
  onViewModeChange,
  validationMessages = [],
  variableSuggestions = [],
  autoFocus = false,
  className,
  'aria-label': ariaLabel = 'Markdown document'
}: MarkdownDocumentEditorProps) {
  const reactId = useId()
  const sourceTabId = `${reactId}-source-tab`
  const previewTabId = `${reactId}-preview-tab`
  const sourcePanelId = `${reactId}-source-panel`
  const previewPanelId = `${reactId}-preview-panel`

  const [uncontrolledView, setUncontrolledView] = useState<MarkdownEditorViewMode>(defaultViewMode)
  const activeView: MarkdownEditorViewMode = viewMode ?? uncontrolledView
  const isPreview = activeView === 'preview'

  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<MonacoEditor | null>(null)
  const saveRef = useRef(onSave)
  const selectionRef = useRef<MarkdownEditorSelection | null>(null)
  const suggestionsRef = useRef(variableSuggestions)
  const onChangeRef = useRef(onChange)
  const readOnlyRef = useRef(readOnly)

  saveRef.current = onSave
  suggestionsRef.current = variableSuggestions
  onChangeRef.current = onChange
  readOnlyRef.current = readOnly

  const setView = useCallback(
    (next: MarkdownEditorViewMode) => {
      const editorInstance = editorRef.current
      if (editorInstance) {
        const current = editorInstance.getSelection()
        if (current) {
          selectionRef.current = {
            startLineNumber: current.startLineNumber,
            startColumn: current.startColumn,
            endLineNumber: current.endLineNumber,
            endColumn: current.endColumn
          }
        }
      }
      if (viewMode === undefined) setUncontrolledView(next)
      onViewModeChange?.(next)
      if (next === 'source') {
        queueMicrotask(() => {
          const instance = editorRef.current
          if (!instance) return
          const restored = restoreMarkdownSelection(selectionRef.current)
          instance.setSelection({
            startLineNumber: restored.startLineNumber,
            startColumn: restored.startColumn,
            endLineNumber: restored.endLineNumber,
            endColumn: restored.endColumn
          })
          instance.focus()
        })
      }
    },
    [onViewModeChange, viewMode]
  )

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

  useEffect(() => {
    const monaco = monacoRef.current
    const instance = editorRef.current
    if (!monaco || !instance) return
    const model = instance.getModel()
    if (!model) return
    monaco.editor.setModelMarkers(
      model,
      'mousse-markdown',
      validationMessages.map((message, index) => {
        const line = Math.max(1, message.line ?? 1)
        const column = Math.max(1, message.column ?? 1)
        return {
          code: message.id ?? String(index),
          message: message.message,
          severity: severityToMonaco(monaco, message.severity),
          startLineNumber: line,
          startColumn: column,
          endLineNumber: message.endLine ?? line,
          endColumn: message.endColumn ?? column + 1
        }
      })
    )
  }, [validationMessages, value])

  const beforeMount: BeforeMount = (monaco) => applyEditorTheme(monaco)

  const onMount: OnMount = (editorInstance, monaco) => {
    monacoRef.current = monaco
    editorRef.current = editorInstance
    applyEditorTheme(monaco)
    // Monaco's synchronous automatic layout can resize its observed box during
    // ResizeObserver delivery (notably inside a scrollable modal). Apply the
    // latest box size in the next animation frame to avoid feedback loops.
    const container = editorInstance.getContainerDomNode()
    let layoutFrame = 0
    let previousWidth = -1, previousHeight = -1
    const scheduleLayout = () => {
      if (layoutFrame) return
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0
        const width = container.clientWidth, height = container.clientHeight
        if (!width || !height || (width === previousWidth && height === previousHeight)) return
        previousWidth = width; previousHeight = height
        editorInstance.layout({ width, height })
      })
    }
    const resizeObserver = new ResizeObserver(scheduleLayout)
    resizeObserver.observe(container)
    scheduleLayout()
    editorInstance.onDidDispose(() => {
      resizeObserver.disconnect()
      if (layoutFrame) cancelAnimationFrame(layoutFrame)
    })
    editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current?.()
    })
    const completion: IDisposable = monaco.languages.registerCompletionItemProvider('markdown', {
      triggerCharacters: ['{', '$'],
      provideCompletionItems: (model, position) => {
        const suggestions = suggestionsRef.current
        if (suggestions.length === 0) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn
        }
        const items: languages.CompletionItem[] = suggestions.map((suggestion) => ({
          label: suggestion.name,
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: variableCompletionInsertText(suggestion),
          detail: suggestion.detail,
          range
        }))
        return { suggestions: items }
      }
    })
    editorInstance.onDidDispose(() => completion.dispose())
    if (autoFocus) editorInstance.focus()
  }

  const handleChange = (next: string | undefined) => {
    if (readOnlyRef.current) return
    onChangeRef.current?.(next ?? '')
  }

  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}
      aria-label={ariaLabel}
    >
      <MarkdownViewTabs
        viewMode={activeView}
        sourceTabId={sourceTabId}
        previewTabId={previewTabId}
        sourcePanelId={sourcePanelId}
        previewPanelId={previewPanelId}
        onViewModeChange={setView}
      />
      {validationMessages.length > 0 ? (
        <ul className="panel-error" aria-label="Markdown validation">
          {validationMessages.map((message, index) => (
            <li key={message.id ?? `${message.severity}-${index}`}>
              {message.severity}: {message.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'grid', position: 'relative' }}>
        <div
          id={sourcePanelId}
          role="tabpanel"
          aria-labelledby={sourceTabId}
          aria-hidden={isPreview}
          className="files-monaco-editor"
          style={{
            gridArea: '1 / 1',
            visibility: isPreview ? 'hidden' : 'visible',
            pointerEvents: isPreview ? 'none' : 'auto',
            zIndex: isPreview ? 0 : 1
          }}
        >
          <Editor
            path={path}
            value={value}
            language="markdown"
            theme={MOUSSE_EDITOR_THEME}
            beforeMount={beforeMount}
            onMount={onMount}
            onChange={handleChange}
            options={{
              readOnly,
              automaticLayout: false,
              bracketPairColorization: { enabled: true },
              matchBrackets: 'always',
              minimap: { enabled: true },
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              fontFamily: CODE_FONT,
              fontSize: 13,
              tabSize: 2,
              detectIndentation: true,
              wordWrap: 'off',
              ariaLabel: `${ariaLabel} source`
            }}
          />
        </div>
        <div
          id={previewPanelId}
          role="tabpanel"
          aria-labelledby={previewTabId}
          aria-hidden={!isPreview}
          style={{
            gridArea: '1 / 1',
            visibility: isPreview ? 'visible' : 'hidden',
            pointerEvents: isPreview ? 'auto' : 'none',
            zIndex: isPreview ? 1 : 0,
            minHeight: 0,
            overflow: 'auto'
          }}
        >
          <MarkdownPreview value={value} />
        </div>
      </div>
    </div>
  )
}

export function parseMarkdownViewMode(value: string | null | undefined): MarkdownEditorViewMode | undefined {
  return isMarkdownEditorViewMode(value) ? value : undefined
}

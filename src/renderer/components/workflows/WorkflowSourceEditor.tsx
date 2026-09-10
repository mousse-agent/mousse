import Editor from '@monaco-editor/react'
import { MarkdownDocumentEditor } from '../editors/MarkdownDocumentEditor'

export function WorkflowSourceEditor({
  value,
  diagnosticsText,
  readOnly,
  onChange,
  onSave
}: {
  value: string
  diagnosticsText?: string
  readOnly?: boolean
  onChange: (value: string) => void
  onSave?: () => void
}) {
  return (
    <div className="wf-source" data-source-editor="">
      <label className="wf-hidden" htmlFor="workflow-source-text">
        workflow.json
      </label>
      <textarea
        id="workflow-source-text"
        className="wf-hidden"
        data-source-text=""
        spellCheck={false}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Editor
        height="100%"
        defaultLanguage="json"
        value={value}
        theme="vs-dark"
        options={{
          readOnly: Boolean(readOnly),
          minimap: { enabled: false },
          fontSize: 13,
          wordWrap: 'on',
          automaticLayout: true
        }}
        onChange={(next) => {
          if (typeof next === 'string') onChange(next)
        }}
        onMount={(editor) => {
          editor.addCommand(2048 | 49, () => onSave?.())
        }}
      />
      {diagnosticsText ? (
        <p className="wf-field-error" role="alert" data-source-status="">
          {diagnosticsText}
        </p>
      ) : (
        <p className="wf-status" data-source-status="">
          Valid JSON. Apply to update the canvas.
        </p>
      )}
    </div>
  )
}

export function WorkflowAssetMarkdownEditor({
  path,
  value,
  readOnly,
  onChange
}: {
  path: string
  value: string
  readOnly?: boolean
  onChange: (value: string) => void
}) {
  return (
    <MarkdownDocumentEditor
      path={path}
      value={value}
      readOnly={readOnly}
      onChange={onChange}
      aria-label="Workflow markdown asset"
    />
  )
}

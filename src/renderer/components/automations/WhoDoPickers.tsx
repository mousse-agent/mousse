import { useCallback, useEffect, useState } from 'react'
import { workflowInputFields, type WorkflowInputField } from '../../../shared/workflows/workflowCommand'
import { createAgentDefinitionsClient } from '../../services/agentDefinitionsClient'
import { createWorkflowDefinitionsClient } from '../../services/workflowDefinitionsClient'
import { createPersonalBotsClient } from '../../services/personalBotsClient'
import type { WorkflowDocumentDto } from '../../../shared/workflowPlatform'
import { Select, type SelectOption } from '../ui/Select'
import { EMPTY_LIBRARY, libraryFrom, type AutomationLibrary, type WorkflowChoice } from './whoDo'

/**
 * What fills an automation's Who and Do: the profile's published saved agents and workflows, and its bots. A list that
 * cannot be read is left out (its picker section is empty), and the rest still loads.
 */
export function useAutomationLibrary(profileId: string): { library: AutomationLibrary; reload: () => void } {
  const [library, setLibrary] = useState<AutomationLibrary>(EMPTY_LIBRARY)
  const load = useCallback(async () => {
    const request = window.mousse?.platformRequest
    if (!request || !profileId) return
    const [agents, workflows, bots] = await Promise.all([
      createAgentDefinitionsClient(request).list({ profileId }).catch(() => []),
      createWorkflowDefinitionsClient(request).list({ profileId }).catch(() => []),
      createPersonalBotsClient(request).list().catch(() => [])
    ])
    setLibrary(libraryFrom({ agents, workflows, bots }))
  }, [profileId])
  useEffect(() => { void load() }, [load])
  const reload = useCallback(() => { void load() }, [load])
  return { library, reload }
}

/** A workflow's input fields, read from its published revision; empty while loading or when it asks for none. */
export function useWorkflowFields(profileId: string, workflow: Pick<WorkflowChoice, 'id' | 'revisionId'> | null | undefined): { fields: WorkflowInputField[]; loading: boolean } {
  const [state, setState] = useState<{ key: string; fields: WorkflowInputField[] } | null>(null)
  const key = workflow ? `${workflow.id}@${workflow.revisionId}` : ''
  useEffect(() => {
    if (!workflow || !profileId) return
    let live = true
    const request = window.mousse?.platformRequest
    if (!request) return
    // Only the compiled input schema is read, so the bundle is not decoded.
    request.request<Pick<WorkflowDocumentDto, 'compiled'>>('workflows.getRevision', { profileId, id: workflow.id, revisionId: workflow.revisionId })
      .then((document) => { if (live) setState({ key, fields: workflowInputFields(document.compiled.inputSchema) }) })
      .catch(() => { if (live) setState({ key, fields: [] }) })
    return () => { live = false }
    // The key names the workflow and its revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, profileId])
  return { fields: state?.key === key ? state.fields : [], loading: Boolean(workflow) && state?.key !== key }
}

/** The Do picker: a prompt, or one of the published workflows. */
export function DoPicker({ value, workflows, onChange, className = 'automation-chip-select', promptLabel = 'Prompt' }: {
  /** `''` for a prompt, else the workflow's id. */
  value: string
  workflows: readonly WorkflowChoice[]
  onChange: (workflowId: string) => void
  className?: string
  /** What the chip says for a prompt ("this" in the detail's sentence). */
  promptLabel?: string
}) {
  const options: SelectOption[] = [
    { value: '', label: 'A prompt' },
    ...workflows.map((workflow) => ({ value: workflow.id, label: `/${workflow.slug}`, group: 'Workflows' }))
  ]
  const current = workflows.find((workflow) => workflow.id === value)
  return (
    <Select
      ariaLabel="Do"
      className={className}
      size="small"
      value={value}
      options={options}
      title={current ? current.name : 'What it does: a prompt, or a workflow (type / to pick one)'}
      renderValue={() => <span data-testid="automation-do">{current ? `/${current.slug}` : promptLabel}</span>}
      onChange={onChange}
    />
  )
}

/** A workflow's inputs, in place of the prompt. */
export function WorkflowInputs({ fields, values, loading, onChange }: {
  fields: readonly WorkflowInputField[]
  values: Readonly<Record<string, string>>
  loading?: boolean
  onChange: (key: string, value: string) => void
}) {
  if (loading) return <p className="scheduled-note" data-testid="automation-workflow-inputs">Reading its inputs…</p>
  if (!fields.length) return <p className="scheduled-note" data-testid="automation-workflow-inputs">It takes no inputs.</p>
  return (
    <div className="automation-workflow-inputs" data-testid="automation-workflow-inputs">
      {fields.map((field) => {
        const id = `automation-input-${field.key}`
        const value = values[field.key] ?? ''
        return (
          <label key={field.key} className="automation-workflow-input" htmlFor={id} title={field.description}>
            <span className="automation-workflow-input-label">{field.label}{field.required ? ' *' : ''}</span>
            {field.type === 'boolean' ? (
              <input id={id} type="checkbox" checked={value === 'true'} onChange={(event) => onChange(field.key, event.target.checked ? 'true' : '')} />
            ) : field.options ? (
              <Select
                id={id}
                className="scheduled-select"
                size="small"
                value={value}
                options={[{ value: '', label: 'Choose…' }, ...field.options.map((option) => ({ value: option, label: option }))]}
                onChange={(next) => onChange(field.key, next)}
              />
            ) : (
              <input
                id={id}
                className="scheduled-input"
                data-input={field.key}
                inputMode={field.type === 'number' || field.type === 'integer' ? 'decimal' : undefined}
                value={value}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            )}
          </label>
        )
      })}
    </div>
  )
}

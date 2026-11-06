import { useEffect, useId, useState } from 'react'
import {
  EFFECT_CLASSES,
  JOIN_POLICIES,
  getNodeCatalogEntry,
  type WorkflowManifest,
  type WorkflowNode
} from '../../../shared/workflows'
import { AgentDefinitionPicker } from '../agentDefinitions/AgentDefinitionPicker'
import { AgentDefinitionReadOnlySummary } from '../agentDefinitions/AgentDefinitionReadOnlySummary'
import type { AgentDefinitionsClient } from '../agentDefinitions/client'
import { MarkdownDocumentEditor } from '../editors/MarkdownDocumentEditor'
import { Select, type SelectOption } from '../ui/Select'
import { BindingEditor } from './BindingEditor'
import { ExpressionEditor } from './ExpressionEditor'
import { JsonObjectEditor } from './JsonObjectEditor'
import { isKnownNodeType } from './defaultNode'
import type { WorkflowEditorCatalogs } from './client'

export function WorkflowInspector({
  profileId,
  manifest,
  node,
  readOnly,
  catalogs,
  agentDefinitions,
  instructions,
  onChangeNode,
  onChangeManifest,
  onChangeInstructions
}: {
  profileId: string
  manifest: WorkflowManifest
  node: WorkflowNode | null
  readOnly?: boolean
  catalogs: WorkflowEditorCatalogs
  agentDefinitions?: AgentDefinitionsClient
  instructions: string
  onChangeNode: (node: WorkflowNode) => void
  onChangeManifest: (manifest: WorkflowManifest) => void
  onChangeInstructions: (value: string) => void
}) {
  if (!node) {
    return (
      <aside className="wf-inspector" data-inspector="" aria-label="Workflow inspector">
        <h2>Workflow settings</h2>
        <p className="wf-help">Select a step on the canvas to configure it.</p>
        <label className="wf-field">
          Name
          <input
            data-field="name"
            disabled={readOnly}
            value={manifest.name}
            onChange={(event) => onChangeManifest({ ...manifest, name: event.target.value })}
          />
        </label>
        <label className="wf-field">
          Slash command
          <input
            data-field="slug"
            disabled={readOnly}
            value={manifest.slug}
            onChange={(event) => onChangeManifest({ ...manifest, slug: event.target.value })}
          />
        </label>
        <label className="wf-field">
          Description
          <textarea
            data-field="description"
            disabled={readOnly}
            value={manifest.description ?? ''}
            onChange={(event) => onChangeManifest({ ...manifest, description: event.target.value })}
          />
        </label>
        <details className="wf-details"><summary>Inputs & outputs</summary>
        <p className="wf-help">Define structured data accepted and returned by this workflow.</p>
        <JsonObjectEditor
          id="input-schema"
          label="Input schema"
          readOnly={readOnly}
          value={manifest.inputSchema}
          onChange={(value) => onChangeManifest({ ...manifest, inputSchema: value as WorkflowManifest['inputSchema'] })}
        />
        <JsonObjectEditor
          id="output-schema"
          label="Output schema"
          readOnly={readOnly}
          value={manifest.outputSchema}
          onChange={(value) => onChangeManifest({ ...manifest, outputSchema: value as WorkflowManifest['outputSchema'] })}
        />
        </details>
        <details className="wf-details"><summary>Instructions</summary>
        <label className="wf-field">
          Instructions file
          <input
            disabled={readOnly}
            value={manifest.instructionsFile ?? ''}
            onChange={(event) => onChangeManifest({ ...manifest, instructionsFile: event.target.value || undefined })}
          />
        </label>
        {manifest.instructionsFile ? (
          <div className="wf-field">
            <span>Instructions</span>
            <MarkdownDocumentEditor
              value={instructions}
              readOnly={readOnly}
              path={`workflows/${manifest.id}/instructions.md`}
              onChange={onChangeInstructions}
              aria-label="Workflow instructions"
            />
          </div>
        ) : null}
        </details>
        <details className="wf-details"><summary>Limits & permissions</summary>
        <JsonObjectEditor
          id="limits"
          label="Limits"
          readOnly={readOnly}
          value={manifest.limits ?? {}}
          onChange={(value) => onChangeManifest({ ...manifest, limits: value as WorkflowManifest['limits'] })}
        />
        <JsonObjectEditor
          id="permissions"
          label="Requested capabilities"
          readOnly={readOnly}
          value={manifest.permissions ?? { capabilities: [] }}
          onChange={(value) => onChangeManifest({ ...manifest, permissions: value as WorkflowManifest['permissions'] })}
        />
        </details>
      </aside>
    )
  }

  const entry = getNodeCatalogEntry(node.type)
  const patch = (next: Partial<WorkflowNode> & { config?: Record<string, unknown> }) => {
    onChangeNode({
      ...node,
      ...next,
      config: next.config ? { ...node.config, ...next.config } : node.config
    })
  }

  return (
    <aside className="wf-inspector" data-inspector="" data-inspected={node.id} aria-label="Node inspector">
      <h2>{entry?.label ?? 'Unsupported node'}</h2>
      {!isKnownNodeType(node.type) ? (
        <p className="wf-field-error" role="status">
          Unsupported type “{node.type}”. Source is preserved and is not coerced to another node.
        </p>
      ) : null}
      <label className="wf-field">
        Node id
        <input value={node.id} disabled readOnly />
      </label>
      <details className="wf-details"><summary>Execution settings</summary>
      <SelectField
        label="Effect"
        disabled={readOnly}
        value={node.effect ?? entry?.defaultEffect ?? 'pure'}
        onChange={(effect) => patch({ effect })}
        options={EFFECT_CLASSES.map((effect) => ({ value: effect, label: effect }))}
      />
      <label className="wf-field">
        Timeout (ms)
        <input
          type="number"
          disabled={readOnly}
          value={node.timeoutMs ?? ''}
          onChange={(event) => patch({ timeoutMs: event.target.value ? Number(event.target.value) : undefined })}
        />
      </label>
      <label className="wf-field">
        Retry attempts
        <input
          type="number"
          disabled={readOnly}
          value={node.retry?.maxAttempts ?? 1}
          onChange={(event) => patch({ retry: { maxAttempts: Number(event.target.value) || 1 } })}
        />
      </label>
      </details>
      {Object.keys(node.inputs ?? {}).map((name) => (
        <BindingEditor
          key={name}
          id={`input-${name}`}
          label={`Input: ${name}`}
          value={node.inputs?.[name]}
          nodes={manifest.nodes}
          readOnly={readOnly}
          onChange={(binding) => patch({ inputs: { ...node.inputs, [name]: binding } })}
        />
      ))}
      <NodeConfigFields
        profileId={profileId}
        node={node}
        manifest={manifest}
        catalogs={catalogs}
        agentDefinitions={agentDefinitions}
        readOnly={readOnly}
        onChangeConfig={(config) => patch({ config })}
      />
      <details className="wf-details"><summary>Advanced configuration</summary>
      <JsonObjectEditor
        id="node-config-raw"
        label="Configuration JSON"
        readOnly={readOnly || !isKnownNodeType(node.type)}
        value={node.config}
        onChange={(value) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) patch({ config: value as Record<string, unknown> })
        }}
      />
      </details>
    </aside>
  )
}

function NodeConfigFields({
  profileId,
  node,
  manifest,
  catalogs,
  agentDefinitions,
  readOnly,
  onChangeConfig
}: {
  profileId: string
  node: WorkflowNode
  manifest: WorkflowManifest
  catalogs: WorkflowEditorCatalogs
  agentDefinitions?: AgentDefinitionsClient
  readOnly?: boolean
  onChangeConfig: (config: Record<string, unknown>) => void
}) {
  const config = node.config
  const set = (key: string, value: unknown) => onChangeConfig({ ...config, [key]: value })
  switch (node.type) {
    case 'instruction':
      return (
        <>
          <label className="wf-field">
            Instruction text
            <textarea disabled={readOnly} value={String(config.text ?? '')} onChange={(event) => set('text', event.target.value)} />
          </label>
        </>
      )
    case 'prompt-template':
      return (
        <label className="wf-field">
          Template
          <textarea disabled={readOnly} value={String(config.template ?? '')} onChange={(event) => set('template', event.target.value)} />
        </label>
      )
    case 'agent':
      return (
        <AgentConfigFields
          profileId={profileId}
          config={config}
          readOnly={readOnly}
          agentDefinitions={agentDefinitions}
          onChange={onChangeConfig}
        />
      )
    case 'script':
      return <ScriptConfigFields config={config} readOnly={readOnly} onChange={onChangeConfig} />
    case 'condition':
    case 'wait-for-condition':
      return (
        <>
          <ExpressionEditor
            id={`${node.id}-expression`}
            label="Expression"
            value={config.expression}
            readOnly={readOnly}
            onChange={(expression) => set('expression', expression)}
          />
          {node.type === 'wait-for-condition' ? (
            <label className="wf-field">
              Timeout (ms)
              <input
                type="number"
                disabled={readOnly}
                value={Number(config.timeoutMs ?? 0)}
                onChange={(event) => set('timeoutMs', Number(event.target.value))}
              />
            </label>
          ) : null}
        </>
      )
    case 'transform':
      return (
        <BindingEditor
          id="transform-value"
          label="Value"
          value={config.value}
          nodes={manifest.nodes}
          readOnly={readOnly}
          onChange={(binding) => set('value', binding)}
        />
      )
    case 'tool':
      return (
        <SelectField
          label="Built-in tool"
          disabled={readOnly}
          value={toolId(config)}
          placeholder="Select tool"
          onChange={(id) => set('tool', { id })}
          options={catalogs.builtinTools.map((tool) => ({ value: tool.id, label: tool.label }))}
        />
      )
    case 'mcp-tool':
      return (
        <>
          <SelectField
            label="MCP server"
            disabled={readOnly}
            value={String(config.serverId ?? '')}
            placeholder="Select server"
            onChange={(serverId) => set('serverId', serverId)}
            options={catalogs.mcpServers.map((server) => ({
              value: server.serverId,
              label: `${server.name}${server.tools.every((tool) => !tool.available) ? ' (unavailable)' : ''}`
            }))}
          />
          <SelectField
            label="Tool"
            disabled={readOnly}
            value={String(config.toolName ?? '')}
            placeholder="Select tool"
            onChange={(toolName) => set('toolName', toolName)}
            options={(catalogs.mcpServers.find((server) => server.serverId === config.serverId)?.tools ?? []).map((tool) => ({
              value: tool.toolName,
              label: `${tool.toolName}${tool.available ? '' : ' (missing)'}`,
              disabled: !tool.available
            }))}
          />
        </>
      )
    case 'load-skill':
      return (
        <SelectField
          label="Skill"
          disabled={readOnly}
          value={skillId(config)}
          placeholder="Select skill"
          onChange={(id) => {
            const skill = catalogs.skills.find((item) => item.id === id)
            set('skill', { id, revision: skill?.revision ?? '' })
          }}
          options={catalogs.skills.map((skill) => ({
            value: skill.id,
            label: `${skill.name}${skill.available ? '' : ' (missing)'}`,
            disabled: !skill.available
          }))}
        />
      )
    case 'join':
      return (
        <>
          <SelectField
            label="Parallel node"
            disabled={readOnly}
            value={String(config.parallelNodeId ?? '')}
            placeholder="Select"
            onChange={(parallelNodeId) => set('parallelNodeId', parallelNodeId)}
            options={manifest.nodes.filter((item) => item.type === 'parallel').map((item) => ({ value: item.id, label: item.id }))}
          />
          <SelectField
            label="Join policy"
            disabled={readOnly}
            value={String(config.policy ?? 'all-success')}
            onChange={(policy) => set('policy', policy)}
            options={JOIN_POLICIES.map((policy) => ({ value: policy, label: policy }))}
          />
        </>
      )
    case 'subworkflow':
      return (
        <SelectField
          label="Subworkflow"
          disabled={readOnly}
          value={subworkflowId(config)}
          placeholder="Select workflow"
          onChange={(id) => {
            const item = catalogs.subworkflows.find((entry) => entry.id === id)
            set('workflow', { id, revision: item?.revision ?? '' })
          }}
          options={catalogs.subworkflows.map((item) => ({ value: item.id, label: item.name }))}
        />
      )
    case 'delay':
      return (
        <label className="wf-field">
          Duration (ms)
          <input
            type="number"
            disabled={readOnly}
            value={Number(config.durationMs ?? 0)}
            onChange={(event) => set('durationMs', Number(event.target.value))}
          />
        </label>
      )
    case 'ask-user':
      return (
        <>
          <label className="wf-field">
            Prompt
            <textarea disabled={readOnly} value={String(config.prompt ?? '')} onChange={(event) => set('prompt', event.target.value)} />
          </label>
          <JsonObjectEditor
            id="ask-schema"
            label="Answer schema"
            readOnly={readOnly}
            value={config.answerSchema ?? { type: 'string' }}
            onChange={(value) => set('answerSchema', value)}
          />
        </>
      )
    case 'approval':
      return (
        <>
          <label className="wf-field">
            Action
            <input disabled={readOnly} value={String(config.action ?? '')} onChange={(event) => set('action', event.target.value)} />
          </label>
          <label className="wf-field">
            Proposal
            <textarea disabled={readOnly} value={String(config.proposal ?? '')} onChange={(event) => set('proposal', event.target.value)} />
          </label>
        </>
      )
    default:
      return (
        <p>
          <small>
            {isKnownNodeType(node.type)
              ? 'Use the fields above and raw config for nested subgraphs or advanced settings.'
              : 'Raw config is shown read-only so the original node is not rewritten.'}
          </small>
        </p>
      )
  }
}

function ScriptConfigFields({
  config,
  readOnly,
  onChange
}: {
  config: Record<string, unknown>
  readOnly?: boolean
  onChange: (config: Record<string, unknown>) => void
}) {
  const set = (key: string, value: unknown) => onChange({ ...config, [key]: value })
  const argv = Array.isArray(config.argv) ? config.argv.map(String) : []
  const fileInputs = Array.isArray(config.fileInputs) ? config.fileInputs : []
  return (
    <>
      <SelectField
        label="Runtime"
        disabled={readOnly}
        value={String(config.runtime ?? 'node')}
        onChange={(runtime) => set('runtime', runtime)}
        options={[
          { value: 'node', label: 'Node' },
          { value: 'python', label: 'Python' },
          { value: 'powershell', label: 'PowerShell' },
          { value: 'bash', label: 'Bash' }
        ]}
      />
      <label className="wf-field">
        Asset path
        <input disabled={readOnly} value={String(config.file ?? '')} onChange={(event) => set('file', event.target.value)} />
      </label>
      <SelectField
        label="Execution mode"
        disabled={readOnly}
        value={String(config.executionMode ?? 'trusted-local')}
        onChange={(executionMode) => set('executionMode', executionMode)}
        options={[
          { value: 'trusted-local', label: 'Trusted local (reviewed code, not a sandbox)' },
          { value: 'sandboxed', label: 'Sandbox unavailable in this installation', disabled: true }
        ]}
      />
      <label className="wf-field">
        argv (one per line)
        <textarea
          disabled={readOnly}
          value={argv.join('\n')}
          onChange={(event) => set('argv', event.target.value.split('\n').filter(Boolean))}
        />
      </label>
      <JsonObjectEditor
        id="file-inputs"
        label="fileInputs staging"
        readOnly={readOnly}
        value={fileInputs}
        onChange={(value) => set('fileInputs', value)}
        hint="pointer, source, destination, rewrite, maxTotalBytes. Ordinary strings are never guessed as paths."
      />
    </>
  )
}

function AgentConfigFields({
  profileId,
  config,
  readOnly,
  agentDefinitions,
  onChange
}: {
  profileId: string
  config: Record<string, unknown>
  readOnly?: boolean
  agentDefinitions?: AgentDefinitionsClient
  onChange: (config: Record<string, unknown>) => void
}) {
  const agent = config.agent && typeof config.agent === 'object' ? (config.agent as Record<string, unknown>) : { kind: 'main' }
  const kind = agent.kind === 'user' ? 'user' : 'main'
  const pin = typeof agent.revision === 'string' && agent.revision && agent.revision !== 'head' ? 'pinned' : 'head'
  const [summary, setSummary] = useState<{ record: Parameters<typeof AgentDefinitionReadOnlySummary>[0]['record'] } | null>(null)

  useEffect(() => {
    const id = typeof agent.definitionId === 'string' ? agent.definitionId : ''
    if (!agentDefinitions || !id) {
      setSummary(null)
      return
    }
    let cancelled = false
    void agentDefinitions
      .get({ profileId, id })
      .then((record) => {
        if (!cancelled) setSummary({ record })
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [agent.definitionId, agentDefinitions, profileId])

  const setAgent = (next: Record<string, unknown>) => onChange({ ...config, agent: next })

  return (
    <>
      <SelectField
        label="Agent kind"
        disabled={readOnly}
        value={kind}
        onChange={(next) => setAgent({ ...agent, kind: next, definitionId: next === 'main' ? undefined : agent.definitionId })}
        options={[
          { value: 'main', label: 'Main agent' },
          { value: 'user', label: 'User agent' }
        ]}
      />
      {kind === 'user' ? (
        <>
          <SelectField
            label="Revision"
            disabled={readOnly}
            value={pin}
            onChange={(next) =>
              setAgent({
                ...agent,
                revision: next === 'head' ? 'head' : typeof agent.revision === 'string' && agent.revision !== 'head' ? agent.revision : ''
              })
            }
            options={[
              { value: 'head', label: 'Follow head' },
              { value: 'pinned', label: 'Pin revision' }
            ]}
          />
          {pin === 'pinned' ? (
            <label className="wf-field">
              Pinned revision
              <input
                disabled={readOnly}
                value={typeof agent.revision === 'string' && agent.revision !== 'head' ? agent.revision : ''}
                onChange={(event) => setAgent({ ...agent, revision: event.target.value })}
              />
            </label>
          ) : null}
          {agentDefinitions ? (
            <AgentDefinitionPicker
              profileId={profileId}
              client={agentDefinitions}
              value={typeof agent.definitionId === 'string' ? agent.definitionId : undefined}
              disabled={readOnly}
              onChange={(id) => setAgent({ ...agent, kind: 'user', definitionId: id })}
            />
          ) : (
            <p>Agent catalog is not connected.</p>
          )}
          {summary ? <AgentDefinitionReadOnlySummary record={summary.record} /> : null}
        </>
      ) : null}
      <label className="wf-field">
        Instructions
        <textarea
          disabled={readOnly}
          value={String(config.instructions ?? '')}
          onChange={(event) => onChange({ ...config, instructions: event.target.value })}
        />
      </label>
      <JsonObjectEditor
        id="agent-output-schema"
        label="Output schema"
        readOnly={readOnly}
        value={config.outputSchema ?? { type: 'object' }}
        onChange={(value) => onChange({ ...config, outputSchema: value })}
      />
    </>
  )
}

/** A labelled field with the shared themed select; the visible label names it. */
function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder
}: {
  label: string
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  placeholder?: string
}) {
  const labelId = useId()
  return (
    <div className="wf-field">
      <span id={labelId}>{label}</span>
      <Select<T> ariaLabelledBy={labelId} value={value} options={options} onChange={onChange} disabled={disabled} placeholder={placeholder} />
    </div>
  )
}

function toolId(config: Record<string, unknown>): string {
  const tool = config.tool
  if (tool && typeof tool === 'object' && 'id' in tool) return String((tool as { id: unknown }).id ?? '')
  return ''
}

function skillId(config: Record<string, unknown>): string {
  const skill = config.skill
  if (skill && typeof skill === 'object' && 'id' in skill) return String((skill as { id: unknown }).id ?? '')
  return ''
}

function subworkflowId(config: Record<string, unknown>): string {
  const workflow = config.workflow
  if (workflow && typeof workflow === 'object' && 'id' in workflow) return String((workflow as { id: unknown }).id ?? '')
  return ''
}

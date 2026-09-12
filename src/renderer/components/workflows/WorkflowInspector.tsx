import { useEffect, useState } from 'react'
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
      <label className="wf-field">
        Effect
        <select
          disabled={readOnly}
          value={node.effect ?? entry?.defaultEffect ?? 'pure'}
          onChange={(event) => patch({ effect: event.target.value as WorkflowNode['effect'] })}
        >
          {EFFECT_CLASSES.map((effect) => (
            <option key={effect} value={effect}>
              {effect}
            </option>
          ))}
        </select>
      </label>
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
        <label className="wf-field">
          Built-in tool
          <select
            disabled={readOnly}
            value={toolId(config)}
            onChange={(event) => set('tool', { id: event.target.value })}
          >
            <option value="">Select tool</option>
            {catalogs.builtinTools.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.label}
              </option>
            ))}
          </select>
        </label>
      )
    case 'mcp-tool':
      return (
        <>
          <label className="wf-field">
            MCP server
            <select disabled={readOnly} value={String(config.serverId ?? '')} onChange={(event) => set('serverId', event.target.value)}>
              <option value="">Select server</option>
              {catalogs.mcpServers.map((server) => (
                <option key={server.serverId} value={server.serverId}>
                  {server.name}
                  {server.tools.every((tool) => !tool.available) ? ' (unavailable)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="wf-field">
            Tool
            <select disabled={readOnly} value={String(config.toolName ?? '')} onChange={(event) => set('toolName', event.target.value)}>
              <option value="">Select tool</option>
              {(catalogs.mcpServers.find((server) => server.serverId === config.serverId)?.tools ?? []).map((tool) => (
                <option key={tool.toolName} value={tool.toolName} disabled={!tool.available}>
                  {tool.toolName}
                  {tool.available ? '' : ' (missing)'}
                </option>
              ))}
            </select>
          </label>
        </>
      )
    case 'load-skill':
      return (
        <label className="wf-field">
          Skill
          <select
            disabled={readOnly}
            value={skillId(config)}
            onChange={(event) => {
              const skill = catalogs.skills.find((item) => item.id === event.target.value)
              set('skill', { id: event.target.value, revision: skill?.revision ?? '' })
            }}
          >
            <option value="">Select skill</option>
            {catalogs.skills.map((skill) => (
              <option key={skill.id} value={skill.id} disabled={!skill.available}>
                {skill.name}
                {skill.available ? '' : ' (missing)'}
              </option>
            ))}
          </select>
        </label>
      )
    case 'join':
      return (
        <>
          <label className="wf-field">
            Parallel node
            <select
              disabled={readOnly}
              value={String(config.parallelNodeId ?? '')}
              onChange={(event) => set('parallelNodeId', event.target.value)}
            >
              <option value="">Select</option>
              {manifest.nodes
                .filter((item) => item.type === 'parallel')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
            </select>
          </label>
          <label className="wf-field">
            Join policy
            <select disabled={readOnly} value={String(config.policy ?? 'all-success')} onChange={(event) => set('policy', event.target.value)}>
              {JOIN_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </select>
          </label>
        </>
      )
    case 'subworkflow':
      return (
        <label className="wf-field">
          Subworkflow
          <select
            disabled={readOnly}
            value={subworkflowId(config)}
            onChange={(event) => {
              const item = catalogs.subworkflows.find((entry) => entry.id === event.target.value)
              set('workflow', { id: event.target.value, revision: item?.revision ?? '' })
            }}
          >
            <option value="">Select workflow</option>
            {catalogs.subworkflows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
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
      <label className="wf-field">
        Runtime
        <select disabled={readOnly} value={String(config.runtime ?? 'node')} onChange={(event) => set('runtime', event.target.value)}>
          <option value="node">Node</option>
          <option value="python">Python</option>
          <option value="powershell">PowerShell</option>
          <option value="bash">Bash</option>
        </select>
      </label>
      <label className="wf-field">
        Asset path
        <input disabled={readOnly} value={String(config.file ?? '')} onChange={(event) => set('file', event.target.value)} />
      </label>
      <label className="wf-field">
        Execution mode
        <select
          disabled={readOnly}
          value={String(config.executionMode ?? 'trusted-local')}
          onChange={(event) => set('executionMode', event.target.value)}
        >
          <option value="trusted-local">Trusted local (reviewed code, not a sandbox)</option>
          <option value="sandboxed" disabled>Sandbox unavailable in this installation</option>
        </select>
      </label>
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
      <label className="wf-field">
        Agent kind
        <select
          disabled={readOnly}
          value={kind}
          onChange={(event) => setAgent({ ...agent, kind: event.target.value, definitionId: event.target.value === 'main' ? undefined : agent.definitionId })}
        >
          <option value="main">Main agent</option>
          <option value="user">User agent</option>
        </select>
      </label>
      {kind === 'user' ? (
        <>
          <label className="wf-field">
            Revision
            <select
              disabled={readOnly}
              value={pin}
              onChange={(event) =>
                setAgent({
                  ...agent,
                  revision: event.target.value === 'head' ? 'head' : typeof agent.revision === 'string' && agent.revision !== 'head' ? agent.revision : ''
                })
              }
            >
              <option value="head">Follow head</option>
              <option value="pinned">Pin revision</option>
            </select>
          </label>
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

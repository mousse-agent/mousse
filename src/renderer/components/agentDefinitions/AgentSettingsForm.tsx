import { AGENT_CAPABILITY_KINDS, AGENT_RUNTIME_KINDS } from '../../../shared/agents/types'
import type {
  AgentCapabilityKind,
  AgentDefinitionSettings,
  AgentExample,
  AgentRuntimeKind
} from '../../../shared/agents/types'
import { MarkdownDocumentEditor } from '../editors/MarkdownDocumentEditor'
import { AgentModelPicker } from './AgentModelPicker'
import type { AgentEditorCatalogs } from './client'
import { AGENT_RUNTIME_LABELS } from './client'
import { JsonValueEditor } from './JsonValueEditor'
import { CheckRow, Field, SettingGroup } from './fields'

export interface AgentSettingsFormProps {
  definitionId: string
  runtimeKind: AgentRuntimeKind
  settings: AgentDefinitionSettings
  systemPrompt: string
  catalogs: AgentEditorCatalogs
  disabled?: boolean
  onRuntimeKindChange: (runtimeKind: AgentRuntimeKind) => void
  onSettingsChange: (settings: AgentDefinitionSettings) => void
  onSystemPromptChange: (value: string) => void
  onSave?: () => void
}

function patch<K extends keyof AgentDefinitionSettings>(
  settings: AgentDefinitionSettings,
  key: K,
  value: AgentDefinitionSettings[K]
): AgentDefinitionSettings {
  return { ...settings, [key]: value }
}

export function AgentSettingsForm({
  definitionId,
  runtimeKind,
  settings,
  systemPrompt,
  catalogs,
  disabled,
  onRuntimeKindChange,
  onSettingsChange,
  onSystemPromptChange,
  onSave
}: AgentSettingsFormProps) {
  const identity = settings.identity
  const promptPath = `agent-definitions/${definitionId}/system.md`

  return (
    <div className="agent-settings-form">
      <SettingGroup pointer="/settings/identity" runtimeKind={runtimeKind} title="Name and purpose" lead="How this agent appears in the library.">
        <Field id="agent-name" label="Name">
          <input
            id="agent-name-input"
            data-field="name"
            value={identity.name}
            disabled={disabled}
            onChange={(event) =>
              onSettingsChange(patch(settings, 'identity', { ...identity, name: event.target.value }))
            }
          />
        </Field>
        <Field id="agent-slug" label="Short id" hint="Used in URLs and commands. The stable UUID is still the real identity.">
          <input
            id="agent-slug-input"
            value={identity.slug}
            disabled={disabled}
            onChange={(event) =>
              onSettingsChange(patch(settings, 'identity', { ...identity, slug: event.target.value.toLowerCase() }))
            }
          />
        </Field>
        <Field id="agent-purpose" label="Purpose">
          <input
            id="agent-purpose-input"
            value={identity.purpose}
            disabled={disabled}
            onChange={(event) =>
              onSettingsChange(patch(settings, 'identity', { ...identity, purpose: event.target.value }))
            }
          />
        </Field>
        <Field id="agent-tags" label="Tags" hint="Comma-separated.">
          <input
            id="agent-tags-input"
            value={identity.tags.join(', ')}
            disabled={disabled}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'identity', {
                  ...identity,
                  tags: event.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean)
                })
              )
            }
          />
        </Field>
        <Field id="agent-runtime" label="Runtime">
          <select
            id="agent-runtime-input"
            data-field="runtime"
            value={runtimeKind}
            disabled={disabled}
            onChange={(event) => onRuntimeKindChange(event.target.value as AgentRuntimeKind)}
          >
            {AGENT_RUNTIME_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {AGENT_RUNTIME_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
      </SettingGroup>

      <SettingGroup
        pointer="/settings/instructions"
        runtimeKind={runtimeKind}
        title="System prompt"
        lead="Pinned when a run starts. Switching Source and Preview keeps the exact text."
      >
        <p>
          <small>{new TextEncoder().encode(systemPrompt).length} bytes</small>
        </p>
        <MarkdownDocumentEditor
          path={promptPath}
          value={systemPrompt}
          onChange={onSystemPromptChange}
          onSave={onSave}
          readOnly={disabled}
          defaultViewMode="source"
          aria-label="System prompt"
          variableSuggestions={[
            { name: 'name', detail: 'Agent name' },
            { name: 'purpose', detail: 'Agent purpose' },
            { name: 'task', detail: 'Current task' }
          ]}
        />
      </SettingGroup>

      <SettingGroup pointer="/settings/primaryModel" runtimeKind={runtimeKind} title="Model" lead="Shared provider catalog. Personal selections stay with this profile's definition.">
        <AgentModelPicker
          catalogs={catalogs}
          value={settings.primaryModel.ref}
          disabled={disabled}
          onChange={(ref) =>
            onSettingsChange(patch(settings, 'primaryModel', { ...settings.primaryModel, ref }))
          }
        />
      </SettingGroup>

      <SettingGroup
        pointer="/settings/primaryModel/capabilityOverrides"
        runtimeKind={runtimeKind}
        title="Capability-specific models"
        lead="Optional replacements when a capability needs a different model. Never silent."
      >
        {AGENT_CAPABILITY_KINDS.map((capability: AgentCapabilityKind) => {
          const current = settings.primaryModel.capabilityOverrides[capability]
          return (
            <div key={capability}>
              <CheckRow
                id={`override-${capability}`}
                checked={Boolean(current)}
                onChange={(enabled) => {
                  const capabilityOverrides = { ...settings.primaryModel.capabilityOverrides }
                  if (enabled) capabilityOverrides[capability] = { ...settings.primaryModel.ref }
                  else delete capabilityOverrides[capability]
                  onSettingsChange(patch(settings, 'primaryModel', { ...settings.primaryModel, capabilityOverrides }))
                }}
              >
                Override for {capability.replaceAll('_', ' ')}
              </CheckRow>
              {current ? (
                <AgentModelPicker
                  catalogs={catalogs}
                  value={current}
                  pointer={`/settings/primaryModel/capabilityOverrides/${capability}`}
                  label={`${capability} model`}
                  disabled={disabled}
                  onChange={(ref) =>
                    onSettingsChange(
                      patch(settings, 'primaryModel', {
                        ...settings.primaryModel,
                        capabilityOverrides: { ...settings.primaryModel.capabilityOverrides, [capability]: ref }
                      })
                    )
                  }
                />
              ) : null}
            </div>
          )
        })}
      </SettingGroup>

      <SettingGroup pointer="/settings/fallbacks" runtimeKind={runtimeKind} title="Fallbacks" lead="Off by default. Fallbacks never cross a missing-capability gap silently.">
        <CheckRow
          id="fallbacks-enabled"
          checked={settings.fallbacks.enabled}
          onChange={(enabled) => onSettingsChange(patch(settings, 'fallbacks', { ...settings.fallbacks, enabled }))}
        >
          Enable ordered fallbacks
        </CheckRow>
        {settings.fallbacks.enabled
          ? settings.fallbacks.models.map((model, index) => (
              <AgentModelPicker
                key={index}
                catalogs={catalogs}
                value={model}
                pointer={`/settings/fallbacks/models/${index}`}
                label={`Fallback ${index + 1}`}
                disabled={disabled}
                onChange={(ref) => {
                  const models = [...settings.fallbacks.models]
                  models[index] = ref
                  onSettingsChange(patch(settings, 'fallbacks', { ...settings.fallbacks, models }))
                }}
              />
            ))
          : null}
        {settings.fallbacks.enabled ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              onSettingsChange(
                patch(settings, 'fallbacks', {
                  ...settings.fallbacks,
                  models: [...settings.fallbacks.models, { providerId: '', modelId: '' }]
                })
              )
            }
          >
            Add fallback
          </button>
        ) : null}
        <div className="agent-inline-fields">
          {(['rate_limit', 'timeout', 'unavailable', 'content_filter'] as const).map((category) => (
            <CheckRow
              key={category}
              id={`retry-${category}`}
              checked={settings.fallbacks.retryOn.includes(category)}
              onChange={(checked) => {
                const retryOn = checked
                  ? [...settings.fallbacks.retryOn, category]
                  : settings.fallbacks.retryOn.filter((item) => item !== category)
                onSettingsChange(patch(settings, 'fallbacks', { ...settings.fallbacks, retryOn }))
              }}
            >
              Retry on {category.replaceAll('_', ' ')}
            </CheckRow>
          ))}
        </div>
        <CheckRow
          id="allow-higher-cost"
          checked={settings.fallbacks.allowHigherCost}
          onChange={(allowHigherCost) =>
            onSettingsChange(patch(settings, 'fallbacks', { ...settings.fallbacks, allowHigherCost }))
          }
        >
          Allow a more expensive fallback
        </CheckRow>
      </SettingGroup>

      <SettingGroup pointer="/settings/output" runtimeKind={runtimeKind} title="Response style">
        <div className="agent-inline-fields">
          <Field id="output-language" label="Language">
            <input
              id="output-language-input"
              value={settings.output.language ?? ''}
              onChange={(event) =>
                onSettingsChange(patch(settings, 'output', { ...settings.output, language: event.target.value || undefined }))
              }
            />
          </Field>
          <Field id="output-tone" label="Tone">
            <input
              id="output-tone-input"
              value={settings.output.tone ?? ''}
              onChange={(event) =>
                onSettingsChange(patch(settings, 'output', { ...settings.output, tone: event.target.value || undefined }))
              }
            />
          </Field>
        </div>
        <Field id="output-verbosity" label="Length">
          <select
            id="output-verbosity-input"
            value={settings.output.verbosity}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'output', { ...settings.output, verbosity: event.target.value as AgentDefinitionSettings['output']['verbosity'] })
              )
            }
          >
            <option value="concise">Concise</option>
            <option value="normal">Normal</option>
            <option value="verbose">Detailed</option>
          </select>
        </Field>
        <Field id="output-citations" label="Citations">
          <select
            id="output-citations-input"
            value={settings.output.citationPreference}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'output', {
                  ...settings.output,
                  citationPreference: event.target.value as AgentDefinitionSettings['output']['citationPreference']
                })
              )
            }
          >
            <option value="none">None</option>
            <option value="inline">Inline</option>
            <option value="footnotes">Footnotes</option>
          </select>
        </Field>
        <Field id="output-format" label="Output format">
          <select
            id="output-format-input"
            value={settings.output.format}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'output', { ...settings.output, format: event.target.value as AgentDefinitionSettings['output']['format'] })
              )
            }
          >
            <option value="markdown">Markdown</option>
            <option value="json">JSON</option>
            <option value="schema">JSON matching a schema</option>
          </select>
        </Field>
        {settings.output.format === 'schema' ? (
          <JsonValueEditor
            id="output-schema"
            label="Output schema"
            value={settings.output.jsonSchema ?? {}}
            onChange={(jsonSchema) => onSettingsChange(patch(settings, 'output', { ...settings.output, jsonSchema }))}
            readOnly={disabled}
          />
        ) : null}
      </SettingGroup>

      <SettingGroup pointer="/settings/context" runtimeKind={runtimeKind} title="What it can read">
        <CheckRow
          id="include-thread"
          checked={settings.context.includeCurrentThread}
          onChange={(includeCurrentThread) =>
            onSettingsChange(patch(settings, 'context', { ...settings.context, includeCurrentThread }))
          }
        >
          Current thread
        </CheckRow>
        <CheckRow
          id="include-project"
          checked={settings.context.includeProjectInstructions}
          onChange={(includeProjectInstructions) =>
            onSettingsChange(patch(settings, 'context', { ...settings.context, includeProjectInstructions }))
          }
        >
          Project instructions
        </CheckRow>
        <Field id="selected-files" label="Selected files" hint="One project-relative path per line.">
          <textarea
            id="selected-files-input"
            rows={4}
            value={settings.context.selectedFiles.join('\n')}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'context', {
                  ...settings.context,
                  selectedFiles: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
                })
              )
            }
          />
        </Field>
        <Field id="attachments" label="Attachments">
          <select
            id="attachments-input"
            value={settings.context.attachmentPolicy}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'context', {
                  ...settings.context,
                  attachmentPolicy: event.target.value as AgentDefinitionSettings['context']['attachmentPolicy']
                })
              )
            }
          >
            <option value="none">None</option>
            <option value="explicit">Only files I list</option>
            <option value="thread">Thread attachments</option>
          </select>
        </Field>
        <Field id="max-context" label="Token budget (optional)">
          <input
            id="max-context-input"
            type="number"
            min={1}
            value={settings.context.maxContextTokens ?? ''}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'context', {
                  ...settings.context,
                  maxContextTokens: event.target.value ? Number(event.target.value) : undefined
                })
              )
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/memory" runtimeKind={runtimeKind} title="Memory" lead="Default is this thread only. Profile memory never leaks to another profile.">
        <Field id="memory-scope" label="Remember">
          <select
            id="memory-scope-input"
            value={settings.memory.scope}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'memory', { ...settings.memory, scope: event.target.value as AgentDefinitionSettings['memory']['scope'] })
              )
            }
          >
            <option value="off">Off</option>
            <option value="thread">This thread</option>
            <option value="profile_agent">This agent in this profile</option>
          </select>
        </Field>
        <Field id="memory-retention" label="Keep for (days)">
          <input
            id="memory-retention-input"
            type="number"
            min={1}
            value={settings.memory.retentionDays ?? ''}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'memory', {
                  ...settings.memory,
                  retentionDays: event.target.value ? Number(event.target.value) : undefined
                })
              )
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/skills" runtimeKind={runtimeKind} title="Skills" lead="Inherit profile skills or pick a specific set. A missing skill keeps the draft but blocks publish/run.">
        <Field id="skills-mode" label="Selection">
          <select
            id="skills-mode-input"
            value={settings.skills.mode}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'skills', { ...settings.skills, mode: event.target.value as AgentDefinitionSettings['skills']['mode'] })
              )
            }
          >
            <option value="inherit">Inherit profile skills</option>
            <option value="explicit">Only skills I enable</option>
          </select>
        </Field>
        {catalogs.skills.map((skill) => {
          const selection = settings.skills.selections.find((item) => item.skillId === skill.id)
          const enabled = selection ? selection.enabled : settings.skills.mode === 'inherit'
          return (
            <div key={skill.id}>
              <CheckRow
                id={`skill-${skill.id}`}
                checked={enabled}
                onChange={(next) => {
                  const selections = settings.skills.selections.filter((item) => item.skillId !== skill.id)
                  selections.push({ skillId: skill.id, enabled: next, pinRevision: selection?.pinRevision })
                  onSettingsChange(patch(settings, 'skills', { ...settings.skills, selections }))
                }}
              >
                {skill.name}
                {!skill.available ? ' (unavailable)' : ''}
                {settings.skills.mode === 'inherit' && !selection ? ' · inherited' : ''}
              </CheckRow>
            </div>
          )
        })}
      </SettingGroup>

      <SettingGroup pointer="/settings/mcp" runtimeKind={runtimeKind} title="MCP tools" lead="Turning on a server is not permission for future tools. Name the tools this agent may use.">
        <Field id="mcp-mode" label="Selection">
          <select
            id="mcp-mode-input"
            value={settings.mcp.mode}
            onChange={(event) =>
              onSettingsChange(patch(settings, 'mcp', { ...settings.mcp, mode: event.target.value as AgentDefinitionSettings['mcp']['mode'] }))
            }
          >
            <option value="inherit">Inherit profile tools</option>
            <option value="explicit">Only tools I enable</option>
          </select>
        </Field>
        {catalogs.mcpServers.map((server) => {
          const current = settings.mcp.servers.find((item) => item.serverId === server.serverId)
          return (
            <div key={server.serverId}>
              <CheckRow
                id={`mcp-${server.serverId}`}
                checked={current?.enabled ?? settings.mcp.mode === 'inherit'}
                onChange={(enabled) => {
                  const servers = settings.mcp.servers.filter((item) => item.serverId !== server.serverId)
                  servers.push({
                    serverId: server.serverId,
                    enabled,
                    tools: current?.tools ?? server.tools.map((tool) => ({ toolName: tool.toolName, enabled: false }))
                  })
                  onSettingsChange(patch(settings, 'mcp', { ...settings.mcp, servers }))
                }}
              >
                {server.name}
              </CheckRow>
              {server.tools.map((tool) => {
                const selected = current?.tools.find((item) => item.toolName === tool.toolName)?.enabled ?? false
                return (
                  <CheckRow
                    key={tool.toolName}
                    id={`mcp-${server.serverId}-${tool.toolName}`}
                    checked={selected}
                    onChange={(enabled) => {
                      const others = (current?.tools ?? []).filter((item) => item.toolName !== tool.toolName)
                      const servers = settings.mcp.servers.filter((item) => item.serverId !== server.serverId)
                      servers.push({
                        serverId: server.serverId,
                        enabled: current?.enabled ?? true,
                        tools: [...others, { toolName: tool.toolName, enabled }]
                      })
                      onSettingsChange(patch(settings, 'mcp', { ...settings.mcp, servers }))
                    }}
                  >
                    {tool.toolName}
                    {!tool.available ? ' (unavailable)' : ''}
                  </CheckRow>
                )
              })}
            </div>
          )
        })}
      </SettingGroup>

      <SettingGroup pointer="/settings/tools" runtimeKind={runtimeKind} title="Built-in tools">
        <Field id="tools-mode" label="Selection">
          <select
            id="tools-mode-input"
            value={settings.tools.mode}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'tools', { ...settings.tools, mode: event.target.value as AgentDefinitionSettings['tools']['mode'] })
              )
            }
          >
            <option value="inherit">Inherit profile tools</option>
            <option value="explicit">Only tools I enable</option>
          </select>
        </Field>
        {catalogs.builtinTools.map((tool) => (
          <CheckRow
            key={tool.id}
            id={`tool-${tool.id}`}
            checked={settings.tools.allowlist.includes(tool.id)}
            onChange={(enabled) => {
              const allowlist = enabled
                ? [...settings.tools.allowlist, tool.id]
                : settings.tools.allowlist.filter((id) => id !== tool.id)
              onSettingsChange(patch(settings, 'tools', { ...settings.tools, allowlist }))
            }}
          >
            {tool.label}
          </CheckRow>
        ))}
      </SettingGroup>

      <SettingGroup pointer="/settings/browser" runtimeKind={runtimeKind} title="Browser" lead="Off for a new generic agent. Turn this on only when the agent should use a browser.">
        <Field id="browser-mode" label="Mode">
          <select
            id="browser-mode-input"
            value={settings.browser.mode}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'browser', { ...settings.browser, mode: event.target.value as AgentDefinitionSettings['browser']['mode'] })
              )
            }
          >
            <option value="disabled">Disabled</option>
            <option value="structured">Structured</option>
            <option value="hybrid">Hybrid</option>
            <option value="native">Native adapter</option>
          </select>
        </Field>
        <Field id="browser-workspace" label="Browser workspace">
          <select
            id="browser-workspace-input"
            value={settings.browser.workspaceId ?? ''}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'browser', { ...settings.browser, workspaceId: event.target.value || undefined })
              )
            }
          >
            <option value="">None</option>
            {catalogs.browserWorkspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="browser-domains" label="Allowed domains" hint="One host per line.">
          <textarea
            id="browser-domains-input"
            rows={3}
            value={settings.browser.allowedDomains.join('\n')}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'browser', {
                  ...settings.browser,
                  allowedDomains: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
                })
              )
            }
          />
        </Field>
        <Field id="browser-trace" label="Keep traces">
          <select
            id="browser-trace-input"
            value={settings.browser.traceRetention}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'browser', {
                  ...settings.browser,
                  traceRetention: event.target.value as AgentDefinitionSettings['browser']['traceRetention']
                })
              )
            }
          >
            <option value="none">None</option>
            <option value="run">This run</option>
            <option value="profile">This profile</option>
          </select>
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/delegation" runtimeKind={runtimeKind} title="Delegation" lead="No recursive children by default.">
        <Field id="delegation-children" label="Agents this one may start">
          {catalogs.childDefinitions.map((child) => (
            <CheckRow
              key={child.id}
              id={`child-${child.id}`}
              checked={settings.delegation.allowedChildDefinitionIds.includes(child.id)}
              onChange={(enabled) => {
                const allowedChildDefinitionIds = enabled
                  ? [...settings.delegation.allowedChildDefinitionIds, child.id]
                  : settings.delegation.allowedChildDefinitionIds.filter((id) => id !== child.id)
                onSettingsChange(patch(settings, 'delegation', { ...settings.delegation, allowedChildDefinitionIds }))
              }}
            >
              {child.name}
            </CheckRow>
          ))}
        </Field>
        <Field id="max-children" label="Max at once">
          <input
            id="max-children-input"
            type="number"
            min={0}
            value={settings.delegation.maxConcurrentChildren}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'delegation', { ...settings.delegation, maxConcurrentChildren: Number(event.target.value) })
              )
            }
          />
        </Field>
        <Field id="max-depth" label="Max depth">
          <input
            id="max-depth-input"
            type="number"
            min={0}
            value={settings.delegation.maxDepth}
            onChange={(event) =>
              onSettingsChange(patch(settings, 'delegation', { ...settings.delegation, maxDepth: Number(event.target.value) }))
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/workspace" runtimeKind={runtimeKind} title="Workspace">
        <Field id="workspace-mode" label="Files this agent may change">
          <select
            id="workspace-mode-input"
            value={settings.workspace.mode}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'workspace', {
                  ...settings.workspace,
                  mode: event.target.value as AgentDefinitionSettings['workspace']['mode']
                })
              )
            }
          >
            <option value="read_only">Read only</option>
            <option value="thread_worktree">Current thread worktree</option>
            <option value="dedicated_child_worktree">Dedicated child worktree</option>
          </select>
        </Field>
        <Field id="permitted-roots" label="Allowed roots" hint="One path per line.">
          <textarea
            id="permitted-roots-input"
            rows={3}
            value={settings.workspace.permittedRoots.join('\n')}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'workspace', {
                  ...settings.workspace,
                  permittedRoots: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
                })
              )
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/script" runtimeKind={runtimeKind} title="Scripts" lead="Prompt text cannot grant script authority.">
        <CheckRow
          id="script-enabled"
          checked={settings.script.enabled}
          onChange={(enabled) => onSettingsChange(patch(settings, 'script', { ...settings.script, enabled }))}
        >
          Allow scripts
        </CheckRow>
        <Field id="interpreters" label="Interpreters" hint="Comma-separated allowlist.">
          <input
            id="interpreters-input"
            value={settings.script.interpreters.join(', ')}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'script', {
                  ...settings.script,
                  interpreters: event.target.value.split(',').map((item) => item.trim()).filter(Boolean)
                })
              )
            }
          />
        </Field>
        <Field id="script-mode" label="Where they run">
          <select
            id="script-mode-input"
            value={settings.script.executionMode}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'script', {
                  ...settings.script,
                  executionMode: event.target.value as AgentDefinitionSettings['script']['executionMode']
                })
              )
            }
          >
            <option value="sandboxed">Sandboxed</option>
            <option value="workspace">Workspace</option>
          </select>
        </Field>
        <CheckRow
          id="script-network"
          checked={settings.script.allowNetwork}
          onChange={(allowNetwork) => onSettingsChange(patch(settings, 'script', { ...settings.script, allowNetwork }))}
        >
          Network
        </CheckRow>
        <CheckRow
          id="script-fs"
          checked={settings.script.allowFilesystem}
          onChange={(allowFilesystem) =>
            onSettingsChange(patch(settings, 'script', { ...settings.script, allowFilesystem }))
          }
        >
          Filesystem
        </CheckRow>
      </SettingGroup>

      <SettingGroup pointer="/settings/approval" runtimeKind={runtimeKind} title="When to ask you">
        <CheckRow
          id="ask-user"
          checked={settings.approval.askUser}
          onChange={(askUser) => onSettingsChange(patch(settings, 'approval', { ...settings.approval, askUser }))}
        >
          Can ask questions
        </CheckRow>
        <Field id="approval-policy" label="Approvals">
          <select
            id="approval-policy-input"
            value={settings.approval.policy}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'approval', {
                  ...settings.approval,
                  policy: event.target.value as AgentDefinitionSettings['approval']['policy']
                })
              )
            }
          >
            <option value="inherit">Use profile policy</option>
            <option value="always">Always ask</option>
            <option value="unattended_deny">Unattended: deny extra authority</option>
            <option value="unattended_allow_readonly">Unattended: allow read-only work</option>
          </select>
        </Field>
        <Field id="unattended" label="If nobody is there">
          <select
            id="unattended-input"
            value={settings.approval.unattendedBehavior}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'approval', {
                  ...settings.approval,
                  unattendedBehavior: event.target.value as AgentDefinitionSettings['approval']['unattendedBehavior']
                })
              )
            }
          >
            <option value="pause">Pause</option>
            <option value="skip">Skip</option>
            <option value="fail">Fail</option>
          </select>
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/limits" runtimeKind={runtimeKind} title="Limits">
        <div className="agent-inline-fields">
          <Field id="max-turns" label="Max turns">
            <input
              id="max-turns-input"
              type="number"
              min={1}
              value={settings.limits.maxTurns}
              onChange={(event) =>
                onSettingsChange(patch(settings, 'limits', { ...settings.limits, maxTurns: Number(event.target.value) }))
              }
            />
          </Field>
          <Field id="max-tools" label="Max tool calls">
            <input
              id="max-tools-input"
              type="number"
              min={1}
              value={settings.limits.maxToolCalls}
              onChange={(event) =>
                onSettingsChange(patch(settings, 'limits', { ...settings.limits, maxToolCalls: Number(event.target.value) }))
              }
            />
          </Field>
          <Field id="max-elapsed" label="Time (ms)">
            <input
              id="max-elapsed-input"
              type="number"
              min={1}
              value={settings.limits.maxElapsedMs}
              onChange={(event) =>
                onSettingsChange(patch(settings, 'limits', { ...settings.limits, maxElapsedMs: Number(event.target.value) }))
              }
            />
          </Field>
        </div>
        <Field id="max-cost" label="Cost cap (USD, optional)" hint="Leave blank if cost is unknown.">
          <input
            id="max-cost-input"
            type="number"
            min={0}
            step="0.01"
            value={settings.limits.maxCostUsd ?? ''}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'limits', {
                  ...settings.limits,
                  maxCostUsd: event.target.value ? Number(event.target.value) : undefined
                })
              )
            }
          />
        </Field>
        <Field id="max-artifact" label="Artifact size (bytes)">
          <input
            id="max-artifact-input"
            type="number"
            min={1}
            value={settings.limits.maxArtifactBytes}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'limits', { ...settings.limits, maxArtifactBytes: Number(event.target.value) })
              )
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/recovery" runtimeKind={runtimeKind} title="Recovery">
        <Field id="retry-count" label="Retries">
          <input
            id="retry-count-input"
            type="number"
            min={0}
            value={settings.recovery.retryCount}
            onChange={(event) =>
              onSettingsChange(patch(settings, 'recovery', { ...settings.recovery, retryCount: Number(event.target.value) }))
            }
          />
        </Field>
        <Field id="backoff" label="Backoff (ms)">
          <input
            id="backoff-input"
            type="number"
            min={0}
            value={settings.recovery.backoffMs}
            onChange={(event) =>
              onSettingsChange(patch(settings, 'recovery', { ...settings.recovery, backoffMs: Number(event.target.value) }))
            }
          />
        </Field>
        <Field id="stop-condition" label="Stop when">
          <input
            id="stop-condition-input"
            value={settings.recovery.stopCondition ?? ''}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'recovery', { ...settings.recovery, stopCondition: event.target.value || undefined })
              )
            }
          />
        </Field>
        <Field id="final-report" label="Final report template">
          <textarea
            id="final-report-input"
            rows={3}
            value={settings.recovery.finalReportTemplate ?? ''}
            onChange={(event) =>
              onSettingsChange(
                patch(settings, 'recovery', { ...settings.recovery, finalReportTemplate: event.target.value || undefined })
              )
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/examples" runtimeKind={runtimeKind} title="Examples and try-run" lead="Test runs are separate and do not write production memory.">
        {settings.examples.map((example, index) => (
          <ExampleEditor
            key={example.id}
            example={example}
            disabled={disabled}
            onChange={(next) => {
              const examples = [...settings.examples]
              examples[index] = next
              onSettingsChange(patch(settings, 'examples', examples))
            }}
            onRemove={() =>
              onSettingsChange(patch(settings, 'examples', settings.examples.filter((item) => item.id !== example.id)))
            }
          />
        ))}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            onSettingsChange(
              patch(settings, 'examples', [
                ...settings.examples,
                { id: `ex-${settings.examples.length + 1}`, name: 'Example', prompt: '' }
              ])
            )
          }
        >
          Add example
        </button>
      </SettingGroup>
    </div>
  )
}

function ExampleEditor({
  example,
  onChange,
  onRemove,
  disabled
}: {
  example: AgentExample
  onChange: (example: AgentExample) => void
  onRemove: () => void
  disabled?: boolean
}) {
  return (
    <div className="agent-try-run">
      <Field id={`example-name-${example.id}`} label="Example name">
        <input
          id={`example-name-${example.id}-input`}
          value={example.name}
          disabled={disabled}
          onChange={(event) => onChange({ ...example, name: event.target.value })}
        />
      </Field>
      <Field id={`example-prompt-${example.id}`} label="Prompt">
        <textarea
          id={`example-prompt-${example.id}-input`}
          rows={4}
          value={example.prompt}
          disabled={disabled}
          onChange={(event) => onChange({ ...example, prompt: event.target.value })}
        />
      </Field>
      <Field id={`example-assert-${example.id}`} label="Assertions" hint="One per line.">
        <textarea
          id={`example-assert-${example.id}-input`}
          rows={3}
          value={(example.assertions ?? []).join('\n')}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...example,
              assertions: event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
            })
          }
        />
      </Field>
      <JsonValueEditor
        id={`example-schema-${example.id}`}
        label="Expected schema"
        value={example.expectedSchema ?? {}}
        readOnly={disabled}
        onChange={(expectedSchema) => onChange({ ...example, expectedSchema })}
      />
      <JsonValueEditor
        id={`example-fixture-${example.id}`}
        label="Fixture context"
        value={example.fixtureContext ?? {}}
        readOnly={disabled}
        onChange={(fixtureContext) => onChange({ ...example, fixtureContext })}
      />
      <button type="button" className="btn btn-sm" onClick={onRemove}>
        Remove example
      </button>
    </div>
  )
}

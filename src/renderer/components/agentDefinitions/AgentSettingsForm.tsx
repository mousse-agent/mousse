import { AGENT_CAPABILITY_KINDS } from '../../../shared/agents/types'
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
import { runsOnLabel } from './editorIssues'
import { CheckRow, Field, FieldSelect, SettingGroup } from './fields'

export interface AgentSettingsFormProps {
  definitionId: string
  /** The kind the definition was saved with: an older CLI kind shows "Saved for <CLI>". */
  savedRuntimeKind?: AgentRuntimeKind
  settings: AgentDefinitionSettings
  systemPrompt: string
  catalogs: AgentEditorCatalogs
  disabled?: boolean
  onSettingsChange: (settings: AgentDefinitionSettings) => void
  onSystemPromptChange: (value: string) => void
  onSave?: () => void
  /** The rest of the settings, past Name, Instructions, Model and What it may use, show only when this is true. */
  moreOpen?: boolean
  onMoreOpenChange?: (open: boolean) => void
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
  savedRuntimeKind,
  settings,
  systemPrompt,
  catalogs,
  disabled,
  onSettingsChange,
  onSystemPromptChange,
  onSave,
  moreOpen = false,
  onMoreOpenChange
}: AgentSettingsFormProps) {
  const identity = settings.identity
  const promptPath = `agent-definitions/${definitionId}/system.md`
  const runsOn = runsOnLabel(catalogs, settings.primaryModel.ref)

  return (
    <div className="agent-settings-form">
      <SettingGroup pointer="/settings/identity" title="Name and purpose" lead="How this agent appears in the library.">
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
        <Field
          id="agent-runtime"
          label="Runs on"
          hint="The provider of the model you pick below. Agents run where Mousse can enforce their workspace and tool limits."
        >
          <p id="agent-runtime-input" className="agent-runs-on" data-field="runtime">
            <span>{runsOn ?? 'Choose a model'}</span>
            {savedRuntimeKind && savedRuntimeKind !== 'mousse' ? (
              <span
                className="agent-chip"
                data-saved-runtime={savedRuntimeKind}
                title="Saved by an earlier version. Saving this agent again saves it for Mousse; it runs on the model's provider either way."
              >
                Saved for {AGENT_RUNTIME_LABELS[savedRuntimeKind]}
              </span>
            ) : null}
          </p>
        </Field>
      </SettingGroup>

      <SettingGroup
        pointer="/settings/instructions"
        title="Instructions"
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

      <SettingGroup pointer="/settings/primaryModel" title="Model" lead="Shared provider catalog. Personal selections stay with this profile's definition.">
        <AgentModelPicker
          catalogs={catalogs}
          value={settings.primaryModel.ref}
          disabled={disabled}
          onChange={(ref) =>
            onSettingsChange(patch(settings, 'primaryModel', { ...settings.primaryModel, ref }))
          }
        />
      </SettingGroup>

      <div className="agent-settings-use" data-agent-use="">
        <h3 className="agent-settings-use-title">What it may use</h3>
      <SettingGroup pointer="/settings/skills" title="Skills" lead="Inherit profile skills or pick a specific set. A missing skill keeps the draft but blocks publish/run.">
        <Field id="skills-mode" label="Selection">
          <FieldSelect
            field="skills-mode"
            value={settings.skills.mode}
            onChange={(mode) => onSettingsChange(patch(settings, 'skills', { ...settings.skills, mode }))}
            options={[
              { value: 'inherit', label: 'Inherit profile skills' },
              { value: 'explicit', label: 'Only skills I enable' }
            ]}
          />
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

      <SettingGroup pointer="/settings/mcp" title="MCP tools" lead="Turning on a server is not permission for future tools. Name the tools this agent may use.">
        <Field id="mcp-mode" label="Selection">
          <FieldSelect
            field="mcp-mode"
            value={settings.mcp.mode}
            onChange={(mode) => onSettingsChange(patch(settings, 'mcp', { ...settings.mcp, mode }))}
            options={[
              { value: 'inherit', label: 'Inherit profile tools' },
              { value: 'explicit', label: 'Only tools I enable' }
            ]}
          />
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

      <SettingGroup pointer="/settings/tools" title="Built-in tools">
        <Field id="tools-mode" label="Selection">
          <FieldSelect
            field="tools-mode"
            value={settings.tools.mode}
            onChange={(mode) => onSettingsChange(patch(settings, 'tools', { ...settings.tools, mode }))}
            options={[
              { value: 'inherit', label: 'Inherit profile tools' },
              { value: 'explicit', label: 'Only tools I enable' }
            ]}
          />
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

      </div>

      <button
        type="button"
        className="agent-settings-more-toggle"
        data-testid="agent-editor-more"
        aria-expanded={moreOpen}
        aria-controls={`agent-more-${definitionId}`}
        onClick={() => onMoreOpenChange?.(!moreOpen)}
      >
        {moreOpen ? 'Less' : 'More'}
        <span className="agent-settings-more-hint">capability models · fallbacks · style · what it reads · memory · browser · delegation · workspace · scripts · asking · limits · recovery · examples</span>
      </button>
      <div id={`agent-more-${definitionId}`} className="agent-settings-more" data-agent-more="" hidden={!moreOpen}>
      <SettingGroup
        pointer="/settings/primaryModel/capabilityOverrides"
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

      <SettingGroup pointer="/settings/fallbacks" title="Fallbacks" lead="Off by default. Fallbacks never cross a missing-capability gap silently.">
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

      <SettingGroup pointer="/settings/output" title="Response style">
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
          <FieldSelect
            field="output-verbosity"
            value={settings.output.verbosity}
            onChange={(verbosity) => onSettingsChange(patch(settings, 'output', { ...settings.output, verbosity }))}
            options={[
              { value: 'concise', label: 'Concise' },
              { value: 'normal', label: 'Normal' },
              { value: 'verbose', label: 'Detailed' }
            ]}
          />
        </Field>
        <Field id="output-citations" label="Citations">
          <FieldSelect
            field="output-citations"
            value={settings.output.citationPreference}
            onChange={(citationPreference) => onSettingsChange(patch(settings, 'output', { ...settings.output, citationPreference }))}
            options={[
              { value: 'none', label: 'None' },
              { value: 'inline', label: 'Inline' },
              { value: 'footnotes', label: 'Footnotes' }
            ]}
          />
        </Field>
        <Field id="output-format" label="Output format">
          <FieldSelect
            field="output-format"
            value={settings.output.format}
            onChange={(format) => onSettingsChange(patch(settings, 'output', { ...settings.output, format }))}
            options={[
              { value: 'markdown', label: 'Markdown' },
              { value: 'json', label: 'JSON' },
              { value: 'schema', label: 'JSON matching a schema' }
            ]}
          />
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

      <SettingGroup pointer="/settings/context" title="What it can read">
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
          <FieldSelect
            field="attachments"
            value={settings.context.attachmentPolicy}
            onChange={(attachmentPolicy) => onSettingsChange(patch(settings, 'context', { ...settings.context, attachmentPolicy }))}
            options={[
              { value: 'none', label: 'None' },
              { value: 'explicit', label: 'Only files I list' },
              { value: 'thread', label: 'Thread attachments' }
            ]}
          />
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

      <SettingGroup pointer="/settings/memory" title="Memory" lead="Default is this thread only. Profile memory never leaks to another profile.">
        <Field id="memory-scope" label="Remember">
          <FieldSelect
            field="memory-scope"
            value={settings.memory.scope}
            onChange={(scope) => onSettingsChange(patch(settings, 'memory', { ...settings.memory, scope }))}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'thread', label: 'This thread' },
              { value: 'profile_agent', label: 'This agent in this profile' }
            ]}
          />
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

      <SettingGroup pointer="/settings/browser" title="Browser" lead="Off for a new generic agent. Turn this on only when the agent should use a browser.">
        <Field id="browser-mode" label="Mode">
          <FieldSelect
            field="browser-mode"
            value={settings.browser.mode}
            onChange={(mode) => onSettingsChange(patch(settings, 'browser', { ...settings.browser, mode }))}
            options={[
              { value: 'disabled', label: 'Disabled' },
              { value: 'structured', label: 'Structured' },
              { value: 'hybrid', label: 'Hybrid' },
              { value: 'native', label: 'Native adapter' }
            ]}
          />
        </Field>
        <Field id="browser-workspace" label="Browser workspace">
          <FieldSelect
            field="browser-workspace"
            value={settings.browser.workspaceId ?? ''}
            onChange={(workspaceId) => onSettingsChange(patch(settings, 'browser', { ...settings.browser, workspaceId: workspaceId || undefined }))}
            options={[
              { value: '', label: 'None' },
              ...catalogs.browserWorkspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))
            ]}
          />
        </Field>
        <Field id="browser-domains" label="Allowed domains" hint="Not enforced yet, so leave it empty (no restriction).">
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
          <FieldSelect
            field="browser-trace"
            value={settings.browser.traceRetention}
            onChange={(traceRetention) => onSettingsChange(patch(settings, 'browser', { ...settings.browser, traceRetention }))}
            options={[
              { value: 'none', label: 'None' },
              { value: 'run', label: 'This run' },
              { value: 'profile', label: 'This profile' }
            ]}
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/delegation" title="Delegation" lead="No recursive children by default.">
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

      <SettingGroup pointer="/settings/workspace" title="Workspace">
        <Field id="workspace-mode" label="Files this agent may change">
          <FieldSelect
            field="workspace-mode"
            value={settings.workspace.mode}
            onChange={(mode) => onSettingsChange(patch(settings, 'workspace', { ...settings.workspace, mode }))}
            options={[
              { value: 'read_only', label: 'Read only' },
              { value: 'thread_worktree', label: 'Current thread worktree' },
              { value: 'dedicated_child_worktree', label: 'Dedicated child worktree' }
            ]}
          />
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

      <SettingGroup pointer="/settings/script" title="Scripts" lead="Prompt text cannot grant script authority.">
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
          <FieldSelect
            field="script-mode"
            value={settings.script.executionMode}
            onChange={(executionMode) => onSettingsChange(patch(settings, 'script', { ...settings.script, executionMode }))}
            options={[
              { value: 'sandboxed', label: 'Sandboxed (unavailable)', disabled: true },
              { value: 'workspace', label: 'Workspace' }
            ]}
          />
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

      <SettingGroup pointer="/settings/approval" title="When to ask you">
        <CheckRow
          id="ask-user"
          checked={settings.approval.askUser}
          onChange={(askUser) => onSettingsChange(patch(settings, 'approval', { ...settings.approval, askUser }))}
        >
          Can ask questions
        </CheckRow>
        <Field id="approval-policy" label="Approvals">
          <FieldSelect
            field="approval-policy"
            value={settings.approval.policy}
            onChange={(policy) => onSettingsChange(patch(settings, 'approval', { ...settings.approval, policy }))}
            options={[
              { value: 'inherit', label: 'Use profile policy' },
              { value: 'always', label: 'Always ask' },
              { value: 'unattended_deny', label: 'Unattended: deny extra authority' },
              { value: 'unattended_allow_readonly', label: 'Unattended: allow read-only work' }
            ]}
          />
        </Field>
        <Field id="unattended" label="If nobody is there">
          <FieldSelect
            field="unattended"
            value={settings.approval.unattendedBehavior}
            onChange={(unattendedBehavior) => onSettingsChange(patch(settings, 'approval', { ...settings.approval, unattendedBehavior }))}
            options={[
              { value: 'pause', label: 'Pause' },
              { value: 'skip', label: 'Skip' },
              { value: 'fail', label: 'Fail' }
            ]}
          />
        </Field>
      </SettingGroup>

      <SettingGroup pointer="/settings/limits" title="Limits">
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

      <SettingGroup pointer="/settings/recovery" title="Recovery">
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

      <SettingGroup pointer="/settings/examples" title="Examples and try-run" lead="Test runs are separate and do not write production memory.">
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

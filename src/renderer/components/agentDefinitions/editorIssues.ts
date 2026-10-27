import type { AgentDefinitionIssue } from '../../../shared/agents/errors'
import type { AgentDefinitionSettings, AgentModelRef } from '../../../shared/agents/types'
import type { AgentEditorCatalogs } from './client'
import { listingServes } from '../../../shared/providerInstances'

export interface EditorFieldIssue {
  pointer: string
  fieldId: string
  message: string
  blocking: boolean
}

export function fieldIdForPointer(pointer: string): string {
  return `agent-field${pointer.replaceAll('/', '-')}`
}

/**
 * The provider listing a model ref runs on (the instance the model picker chose), for "Runs on".
 * Null when the ref names no model or its listing is gone.
 */
export function runsOnLabel(catalogs: AgentEditorCatalogs, ref: AgentModelRef): string | null {
  if (!ref.providerId || !ref.modelId) return null
  return catalogs.providers.find((entry) => listingServes(entry, { instanceId: ref.instanceId, llmProvider: ref.providerId }))?.label ?? null
}

export function findModelInCatalog(
  catalogs: AgentEditorCatalogs,
  providerId: string,
  modelId: string,
  /** The selection's instance: picks the right listing when one provider has several. */
  instanceId?: string
): { providerLabel: string; modelLabel: string } | null {
  const provider = catalogs.providers.find((entry) => listingServes(entry, { instanceId, llmProvider: providerId }))
  const model = provider?.models.find((entry) => entry.id === modelId)
  if (!provider || !model) return null
  return { providerLabel: provider.label, modelLabel: model.label }
}

export function collectEditorIssues(input: {
  settings: AgentDefinitionSettings
  catalogs: AgentEditorCatalogs
  serverIssues?: AgentDefinitionIssue[]
}): EditorFieldIssue[] {
  const issues: EditorFieldIssue[] = []
  const ref = input.settings.primaryModel.ref
  if (!ref.providerId || !ref.modelId) {
    issues.push({
      pointer: '/settings/primaryModel/ref',
      fieldId: fieldIdForPointer('/settings/primaryModel'),
      message: 'Choose a model before publishing or running.',
      blocking: true
    })
  } else if (!findModelInCatalog(input.catalogs, ref.providerId, ref.modelId, ref.instanceId)) {
    issues.push({
      pointer: '/settings/primaryModel/ref',
      fieldId: fieldIdForPointer('/settings/primaryModel'),
      message: `Selected model ${ref.providerId}/${ref.modelId} is not in the shared catalog.`,
      blocking: true
    })
  }

  // Issue lines are de-duplicated by key: a gateway refusal of one model names every setting
  // involved, so it is one line (code, model and where the model is set), linked to its first
  // setting; any other issue is one line per setting and message.
  const keys = issues.map((issue) => `${issue.pointer}:${issue.message}`)
  for (const issue of input.serverIssues ?? []) {
    const pointer = issue.pointer ?? '/settings'
    const model = issue.details?.model
    keys.push(model ? `${issue.code}:${JSON.stringify(model)}:${String(issue.details?.at ?? '')}` : `${pointer}:${issue.message}`)
    issues.push({
      pointer,
      fieldId: fieldIdForPointer(pointer),
      message: issue.message,
      // A refused fallback is skipped by the run, so it does not block (`details.blocking: false`).
      blocking:
        issue.details?.blocking !== false &&
        (issue.code === 'MODEL_CAPABILITY_MISSING' ||
          issue.code === 'DEPENDENCY_MISSING' ||
          issue.code === 'SETTINGS_UNSUPPORTED')
    })
  }

  const seen = new Set<string>()
  return issues.filter((_issue, index) => {
    const key = keys[index]!
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The gateway check's issues the editor shows (PR 4 §6): the check answered for the saved draft
 * (`checked`, which Publish waits for), and its issues only while the settings have no unsaved
 * edits, since they answer for the saved settings (a model picked but not saved would contradict them).
 */
export function editorRuntimeIssues(input: {
  answer: { draftHash: string; issues: AgentDefinitionIssue[] } | null
  draftHash: string | undefined
  settings: AgentDefinitionSettings | undefined
  savedSettings: AgentDefinitionSettings | undefined
}): { checked: boolean; serverIssues?: AgentDefinitionIssue[] } {
  const checked = Boolean(input.answer && input.draftHash && input.answer.draftHash === input.draftHash)
  const edited = JSON.stringify(input.settings) !== JSON.stringify(input.savedSettings)
  return checked && !edited ? { checked, serverIssues: input.answer!.issues } : { checked }
}

export function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'agent'
}

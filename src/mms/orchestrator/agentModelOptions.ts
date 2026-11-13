import { describeStatus, type InstanceSnapshot } from '../../shared/harness/status'
import { findListedModel } from '../../shared/modelChoice'
import { purposeAllowed } from '../harness/policy'

/**
 * What an agent may name when it starts a subagent (`delegate_task`) or a thread (`thread_create`): the
 * provider entries the model picker offers, read from the same snapshots (`providers.snapshots`), so an agent
 * can match a model the person names to an `instanceId` and `model` instead of guessing ids.
 */
export interface AgentModelEntry {
  /** The `instanceId` to pass. */
  instanceId: string
  /** The entry's name in the picker ("Claude Code", "OpenAI"). */
  name: string
  /** The agent runtime that runs it (claude, codex, pi, ...). */
  runtime: string
  /** It can run work now. False: `status` says why, and a call naming it is refused. */
  ready: boolean
  status?: string
  /** It can run a subagent's work (an agent that approves tools itself runs only chats a person drives). */
  subagents: boolean
  models: AgentModelOption[]
}

export interface AgentModelOption {
  /** The `model` to pass. */
  id: string
  name: string
  /** The reasoning levels (`effort`) it takes; absent when it has none to choose. */
  efforts?: string[]
  defaultEffort?: string
}

/** Why an entry cannot run work now, in words an agent can repeat; undefined when it can. */
function unavailable(snapshot: InstanceSnapshot): string | undefined {
  const status = describeStatus(snapshot)
  const signedOut = snapshot.auth.state === 'signed_out' || snapshot.auth.state === 'expired'
  if (!signedOut && status.tone !== 'error' && status.tone !== 'disabled' && snapshot.install.state !== 'not_installed') return undefined
  return status.detail ? `${status.headline}: ${status.detail}` : status.headline
}

/**
 * The picker's entries for an agent: every entry switched on in the scope (a locked one runs bot turns only),
 * with its models less the hidden ones, each with its reasoning levels.
 */
export function agentModelEntries(snapshots: readonly InstanceSnapshot[]): AgentModelEntry[] {
  const entries: AgentModelEntry[] = []
  for (const snapshot of snapshots) {
    if (!snapshot.enabled.effective || snapshot.config?.profile === 'locked') continue
    const why = unavailable(snapshot)
    entries.push({
      instanceId: snapshot.instanceId,
      name: snapshot.displayName,
      runtime: snapshot.driver,
      ready: !why,
      ...(why ? { status: why } : {}),
      subagents: purposeAllowed(snapshot.caps, 'delegate_task'),
      models: snapshot.models.entries
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          name: model.label,
          ...(model.capabilities.efforts.length ? { efforts: [...model.capabilities.efforts] } : {}),
          ...(model.capabilities.defaultEffort ? { defaultEffort: model.capabilities.defaultEffort } : {})
        }))
    })
  }
  return entries
}

export interface AgentModelRefusal {
  code: 'unknown_instance' | 'instance_unavailable' | 'model_not_offered' | 'effort_not_offered'
  message: string
}

/** The models of an entry as a short list for a refusal: "a, b, c" and a count past ten. */
function modelList(entry: AgentModelEntry): string {
  const ids = entry.models.map((model) => model.id)
  return ids.length > 10 ? `${ids.slice(0, 10).join(', ')} and ${ids.length - 10} more` : ids.join(', ')
}

/**
 * Why `instanceId`/`model`/`effort` cannot be started on `where` ("this computer", a computer's name), with
 * nothing started instead; undefined when the listing offers it. An entry whose listing is empty (an agent
 * that lists its models only once it runs) is not refused for its model, since nothing here can tell. An entry
 * the listing does not have is refused only with `unlisted: 'refuse'` (another computer's): on this one, resolving
 * the selection refuses it with the reason it has (unknown, turned off for the project).
 */
export function agentModelRefusal(
  entries: readonly AgentModelEntry[],
  choice: { instanceId: string; model?: string; effort?: string },
  where: string,
  options: { unlisted?: 'refuse' | 'leave' } = {}
): AgentModelRefusal | undefined {
  const entry = entries.find((candidate) => candidate.instanceId === choice.instanceId)
  const offered = entries.map((candidate) => candidate.instanceId).join(', ')
  if (!entry && options.unlisted !== 'refuse') return undefined
  if (!entry)
    return { code: 'unknown_instance', message: `${where.charAt(0).toUpperCase()}${where.slice(1)} offers no "${choice.instanceId}" (offered: ${offered || 'none'}). Nothing was started. Check the name with list_models, or tell the user it is not set up.` }
  if (!entry.ready)
    return { code: 'instance_unavailable', message: `${entry.name} on ${where} cannot run now (${entry.status}). Nothing was started. Tell the user why, and ask before using another model.` }
  if (!choice.model || entry.models.length === 0) return undefined
  const model = findListedModel(entry.models, choice.model)
  if (!model)
    return { code: 'model_not_offered', message: `${entry.name} on ${where} does not offer the model "${choice.model}" (offered: ${modelList(entry)}). Nothing was started.` }
  // A model whose listing names no levels may still take one the agent knows; only a listed set refuses.
  if (choice.effort && model.efforts?.length && !model.efforts.includes(choice.effort))
    return { code: 'effort_not_offered', message: `${model.name} takes reasoning levels ${model.efforts.join(', ')}, not "${choice.effort}". Nothing was started.` }
  return undefined
}

import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { BrowserToolContext, BrowserToolOutput } from '../../../shared/browser/automation'
import type { ExecutionContext } from '../../../shared/execution/types'
import { imagePointToViewport } from '../../../shared/browser/geometry'
import type { BrowserElement, BrowserObservation, BrowserPoint } from '../../../shared/browser/types'
import { BrowserAutomationError } from '../../browser/automation/BrowserSessionManager'
import type { MmsProfileServices } from '../../MmsProfileServices'
import type { ChatGroupResourceBinding } from './createMmsChatResourceService'
import type { ChatResourceService } from './ChatResourceService'

/** Active-execution admission permits only this chat's agents to share its browser. */
export function createChatBrowserRuntime(
  services: MmsProfileServices,
  assertExecution: (execution: ExecutionContext) => ChatGroupResourceBinding,
  resources?: ChatResourceService
): BrowserRuntimePort {
  const foundObservations = new Map<string, BrowserObservation>()
  const admitted = (execution: ExecutionContext): ChatGroupResourceBinding => {
    const binding = assertExecution(execution)
    if (binding.profileId !== services.profileId || binding.threadId !== execution.threadId || execution.profileId !== binding.profileId || execution.actor.kind !== 'agent'
      || !binding.participants.some((participant) => participant.kind === 'agent' && participant.definitionId === execution.actor.definitionId)) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser execution is not an active member of this chat' })
    return binding
  }
  const normalized = (context: BrowserToolContext): BrowserToolContext => {
    admitted(context.execution)
    // The root validated the exact active run first. Only group browser scope is
    // shared; the execution's immutable policy, actor, budget and abort stay intact.
    const { runId: _run, ...execution } = context.execution
    const grantSignal = services.platform.browser.access.signal
    return { ...context, execution, signal: context.signal ? AbortSignal.any([context.signal, grantSignal]) : grantSignal, target: { backend: 'managed-chromium' } }
  }
  const select = (context: BrowserToolContext, supplied?: unknown) => {
    const records = services.platform.browser.sessions.listThreadSessions({ profileId: services.profileId, threadId: context.execution.threadId })
      .filter((session) => session.backend === 'managed-chromium' && session.runId === undefined && !['closed', 'disconnected', 'recovering', 'starting'].includes(session.lifecycle))
    if (supplied !== undefined) {
      if (typeof supplied !== 'string' || !records.some((session) => session.id === supplied)) throw new BrowserAutomationError({ code: 'profile_mismatch', message: 'Browser session does not belong to this chat' })
      return records.find((session) => session.id === supplied)
    }
    return records[0]
  }
  const publishAgentPresence = async (original: BrowserToolContext, output: BrowserToolOutput, before?: BrowserObservation, rawAction?: unknown): Promise<void> => {
    const observation = output.observation ?? output.action?.observation
    if (!resources || !observation) return
    const binding = admitted(original.execution)
    const participant = binding.participants.find((item) => item.kind === 'agent' && item.definitionId === original.execution.actor.definitionId)!
    let point: BrowserPoint | undefined
    const target = (rawAction as { target?: { kind?: unknown; ref?: unknown; point?: unknown } } | undefined)?.target
    if (target?.kind === 'ref' && before) {
      const element = before.elements.find((item) => item.ref === target.ref)
      if (element?.bounds) point = { x: element.bounds.x + element.bounds.width / 2, y: element.bounds.y + element.bounds.height / 2 }
    } else if (target?.kind === 'image-point' && before?.screenshot && target.point && typeof target.point === 'object') {
      const candidate = target.point as BrowserPoint
      if (Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) point = imagePointToViewport(candidate, before.screenshot, before.viewport)
    }
    try {
      await resources.presenceUpdate({ profileId: binding.profileId, groupId: binding.chatId,
        participantId: participant.id, clientId: `agent:${original.execution.runId}` },
      { kind: 'browser', id: observation.sessionId }, point ? { kind: 'browser', tabId: observation.tabId, generation: observation.generation,
        x: Math.max(0, Math.min(observation.viewport.cssWidth, point.x)), y: Math.max(0, Math.min(observation.viewport.cssHeight, point.y)) } : undefined)
    } catch { /* A presence observer cannot invalidate an already completed browser effect. */ }
  }
  return {
    resolveTarget(execution) { admitted(execution); return { backend: 'managed-chromium' } },
    requestAccess(execution, signal) { admitted(execution); return services.platform.browser.access.request(execution.threadId, signal) },
    async readScreenshot(original, sessionId, artifactId) {
      const context = normalized(original)
      if (!services.platform.browser.access.status().allowed) throw new BrowserAutomationError({ code: 'policy_denied', message: 'The user disabled agents browser access' })
      if (!context.vision) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Screenshots require a vision-capable agent' })
      const session = select(context, sessionId)!
      const artifact = await services.platform.browser.artifacts.read({ profileId: services.profileId, threadId: context.execution.threadId, sessionId: session.id }, artifactId,
        Math.min(context.policy.maxArtifactBytes, 16 * 1024 * 1024))
      admitted(original.execution)
      if (artifact.ref.mediaType !== 'image/png') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Shared browser screenshot must be PNG' })
      return { data: Buffer.from(artifact.bytes).toString('base64'), mimeType: 'image/png' }
    },
    async dispatch(original, name, args) {
      const context = normalized(original)
      if (!services.platform.browser.access.status().allowed) throw new BrowserAutomationError({ code: 'policy_denied', message: 'The user has not allowed agents browser access' })
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Browser arguments must be an object' })
      const params = { ...(args as Record<string, unknown>) }
      const selected = select(context, params.sessionId)
      const latest = selected ? services.platform.browser.sessions.latestObservation(context, selected.id) : undefined
      const found = selected ? foundObservations.get(selected.id) : undefined
      const before = found && found.observationId === params.observationId && found.generation === latest?.generation ? found : latest
      let result: BrowserToolOutput
      if (name === 'browser_open' && selected) {
        if (Object.keys(params).some((key) => !['url', 'persistent', 'workspaceId'].includes(key))) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Unexpected shared browser open argument' })
        if (!context.policy.allowedTools.includes('browser_open') || !context.policy.allowedCapabilities.includes('browser.session') || !context.policy.allowedEffects.includes('external')) throw new BrowserAutomationError({ code: 'policy_denied', message: 'Agent is not allowed to open browser pages' })
        if (context.policy.approvalEffects.includes('external')) throw new BrowserAutomationError({ code: 'approval_required', message: 'Opening a browser page requires approval' })
        if (params.persistent !== undefined || params.workspaceId !== undefined) throw new BrowserAutomationError({ code: 'invalid_action', message: 'The shared chat browser keeps its group storage' })
        if (params.url !== undefined && params.url !== before?.url) {
          const tabs = await services.platform.browser.tools.invoke('browser_tabs', { sessionId: selected.id, operation: 'new', url: params.url }, context)
          if (!tabs.ok) throw new BrowserAutomationError(tabs.error)
        }
        const observed = await services.platform.browser.tools.invoke('browser_observe', { sessionId: selected.id, includeScreenshot: Boolean(context.vision) }, context)
        if (!observed.ok) throw new BrowserAutomationError(observed.error)
        result = { ...observed.value, session: services.platform.browser.sessions.trustedSessionScope({ profileId: services.profileId, threadId: context.execution.threadId, sessionId: selected.id }).record }
      } else {
        if (name !== 'browser_open' && params.sessionId === undefined && selected) params.sessionId = selected.id
        if (name === 'browser_act' && selected) {
          const scope = services.platform.browser.sessions.trustedSessionScope({ profileId: services.profileId, threadId: context.execution.threadId, sessionId: selected.id })
          if (!scope.record.controlLeaseId || scope.record.lifecycle === 'human-controlled') throw new BrowserAutomationError({ code: 'policy_denied', message: 'A person is controlling the shared browser; ask them to resume agents' })
          params.controlLeaseId = scope.record.controlLeaseId
        }
        const dispatched = await services.platform.browser.tools.invoke(name, params, context)
        if (!dispatched.ok) throw new BrowserAutomationError(dispatched.error)
        result = dispatched.value
      }
      admitted(original.execution)
      if (name === 'browser_find' && selected && latest && result.observationId && result.matches) {
        foundObservations.set(selected.id, { ...latest, observationId: result.observationId, elements: result.matches as BrowserElement[] })
        while (foundObservations.size > 128) foundObservations.delete(foundObservations.keys().next().value!)
      }
      await publishAgentPresence(original, result, before, params.action)
      if (result.session) {
        const { controlLeaseId: _lease, ...session } = result.session
        result = { ...result, session }
      }
      return result
    }
  }
}

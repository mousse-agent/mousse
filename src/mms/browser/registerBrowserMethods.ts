import { randomUUID } from 'node:crypto'
import { BROWSER_ACCESS_METHODS } from '../../shared/browser/access'
import { BROWSER_ATTACHED_V1_CAPABILITY } from '../../shared/browser/connectionCommands'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../../shared/browser/automation'
import {
  BROWSER_ATTACHMENT_METHODS,
  BROWSER_GUI_METHODS,
  BROWSER_VIEWER_CAPABILITY,
  MAX_BROWSER_ARTIFACT_READ_BYTES,
  type BrowserArtifactReadResult,
  type BrowserAttachmentRegisterResult,
  type BrowserSessionPublicRecord
} from '../../shared/browser/host'
import type { ExecutionPolicySnapshot } from '../../shared/execution/types'
import { ExecutionPolicyService } from '../execution/ExecutionPolicyService'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import { BrowserAutomationError } from './automation/BrowserSessionManager'
import type { MmsBrowserService } from './MmsBrowserService'

const policies = new ExecutionPolicyService()
const ATTACH_FIELDS: Record<(typeof BROWSER_ATTACHMENT_METHODS)[number], readonly string[]> = {
  'browser.attachments.register': ['registrationId', 'registrationEpoch', 'closureToken', 'uiTabId', 'threadId'],
  'browser.attachments.unregister': ['registrationId', 'registrationEpoch'],
  'browser.attachments.acknowledgeClosed': ['registrationId', 'registrationEpoch', 'closureToken'],
  'browser.attachments.select': ['uiTabId', 'threadId']
}
const GUI_FIELDS: Record<(typeof BROWSER_GUI_METHODS)[number], readonly string[]> = {
  'browser.sessions.takeControl': ['threadId', 'sessionId'],
  'browser.sessions.resume': ['threadId', 'sessionId'],
  'browser.artifacts.read': ['threadId', 'sessionId', 'artifactId']
}

/**
 * A browser without a window is taken over only through its view's hold (`browser.view.hold` for a
 * thread's, `bots.browser.hold` for a bot's), which ends when the window that took it goes away. Take
 * control and Resume here are the in-app tab's, which its own window shows and drives.
 */
const WINDOWLESS_REFUSAL = 'Take over this browser from its view in the thread\'s Browser panel.'

export interface BrowserDomainRegistration {
  dispose(): void
}

function asString(value: unknown, key: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  return value
}

function optionalString(value: unknown, key: string, max = 160): string | undefined {
  return value === undefined ? undefined : asString(value, key, max)
}

function asEpoch(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new DomainRpcError('invalid_params', 'Invalid ' + key)
  return value
}

function requireGui(context: HandlerContext): { connectionId: string; profileId: string; profileEpoch: number } {
  const connection = context.connection
  if (!connection?.id || !connection.binding) throw new DomainRpcError('profile_binding_required', 'Browser methods require an authenticated profile binding')
  if (connection.clientType !== 'gui') throw new DomainRpcError('capability_required', 'Browser host methods require a GUI connection')
  return { connectionId: connection.id, profileId: connection.binding.profileId, profileEpoch: connection.binding.epoch }
}

function rpc(error: unknown): never {
  if (error instanceof DomainRpcError) throw error
  if (error instanceof BrowserAutomationError) throw new DomainRpcError(error.code, error.message, error.details)
  if (error instanceof Error && error.message.startsWith('invalid_action')) throw new DomainRpcError('invalid_params', error.message)
  throw error
}

function viewerPolicy(profileId: string): ExecutionPolicySnapshot {
  return policies.snapshot(profileId, {
    allowedTools: [...BROWSER_AUTOMATION_TOOLS],
    allowedCapabilities: ['browser.session', 'browser.observe', 'browser.action', 'browser.extract', 'browser.task'],
    allowedEffects: ['read', 'write', 'external'],
    approvalEffects: [],
    maxToolCalls: 100,
    maxElapsedMs: 30 * 60_000,
    maxArtifactBytes: 10 * 1024 * 1024
  })
}

function viewerContext(profileId: string, threadId: string, runId: string | undefined, policy: ExecutionPolicySnapshot): BrowserToolContext {
  const rpcId = randomUUID()
  return {
    execution: {
      profileId,
      threadId,
      ...(runId === undefined ? {} : { runId }),
      turnId: `gui-browser:${rpcId}`,
      actor: { kind: 'main' },
      policySnapshotId: policy.id,
      source: 'gui',
      cancellationId: `gui-browser:${rpcId}`
    },
    policy,
    // Viewer RPCs are bounded by BrowserSessionManager's elapsed-time signal. An
    // inert local signal prevents these host-created identities from being
    // resolved through the run cancellation registry, where they do not exist.
    signal: new AbortController().signal,
    vision: true
  }
}

function assertAttachedOwner(browser: MmsBrowserService, sessionId: string, backend: string | undefined, connectionId: string): void {
  if (backend !== 'electron-attached') return
  const owner = browser.attachmentOwnerForSession(sessionId)
  if (!owner || owner.connectionId !== connectionId) throw new DomainRpcError('policy_denied', 'This attached browser session belongs to another GUI connection')
}

/** Bind once before server seal. Root adds BROWSER_GUI_METHODS to the GUI allowlist. */
export function registerBrowserMethods(
  domains: DomainHandlerRegistry,
  servicesForProfile: (profileId: string) => MmsBrowserService | Promise<MmsBrowserService>
): BrowserDomainRegistration {
  const known = new Set<MmsBrowserService>()
  let disposed = false
  const resolve = async (profileId: string): Promise<MmsBrowserService> => {
    if (disposed) throw new DomainRpcError('service_unavailable', 'Browser services are shutting down')
    const service = await servicesForProfile(profileId)
    known.add(service)
    return service
  }
  const closed = domains.onConnectionClosed((connectionId) => {
    for (const service of known) service.revokeConnection(connectionId)
  })

  for (const method of BROWSER_ACCESS_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: BROWSER_VIEWER_CAPABILITY,
      requiredCapabilities: [BROWSER_VIEWER_CAPABILITY],
      validate: (value) => domainObject(value ?? {}, ['profileId', ...(method === 'browser.access.status' ? [] : method === 'browser.access.respond' ? ['requestId', 'allowed'] : ['allowed'])]),
      async handle(context, params, binding) {
        try {
          const owner = requireGui(context)
          if (binding && (binding.profileId !== owner.profileId || binding.epoch !== owner.profileEpoch)) throw new DomainRpcError('profile_mismatch', 'Browser request does not match the connection binding')
          const browser = await resolve(owner.profileId)
          if (method === 'browser.access.status') return browser.accessStatus()
          if (typeof params.allowed !== 'boolean') throw new DomainRpcError('invalid_params', 'allowed must be a boolean')
          return await browser.setAccess(params.allowed, method === 'browser.access.respond' ? asString(params.requestId, 'requestId') : undefined)
        } catch (error) { rpc(error) }
      }
    })
  }

  for (const method of BROWSER_ATTACHMENT_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: BROWSER_ATTACHED_V1_CAPABILITY,
      requiredCapabilities: [BROWSER_ATTACHED_V1_CAPABILITY],
      validate: (value) => domainObject(value ?? {}, ['profileId', ...ATTACH_FIELDS[method]]),
      async handle(context, params, binding) {
        try {
          const owner = requireGui(context)
          if (binding && (binding.profileId !== owner.profileId || binding.epoch !== owner.profileEpoch)) {
            throw new DomainRpcError('profile_mismatch', 'Browser request does not match the connection binding')
          }
          const browser = await resolve(owner.profileId)
          if (method === 'browser.attachments.register') {
            return browser.registerAttachment({
              registrationId: asString(params.registrationId, 'registrationId', 64),
              registrationEpoch: asEpoch(params.registrationEpoch, 'registrationEpoch'),
              closureToken: asString(params.closureToken, 'closureToken', 128),
              uiTabId: asString(params.uiTabId, 'uiTabId'),
              threadId: optionalString(params.threadId, 'threadId')
            }, owner) satisfies BrowserAttachmentRegisterResult
          }
          if (method === 'browser.attachments.unregister') {
            return browser.unregisterAttachment({
              registrationId: asString(params.registrationId, 'registrationId', 64),
              registrationEpoch: asEpoch(params.registrationEpoch, 'registrationEpoch')
            }, owner)
          }
          if (method === 'browser.attachments.acknowledgeClosed') {
            return browser.acknowledgeAttachedGuestClosed({
              registrationId: asString(params.registrationId, 'registrationId', 64),
              registrationEpoch: asEpoch(params.registrationEpoch, 'registrationEpoch'),
              closureToken: asString(params.closureToken, 'closureToken', 128)
            }, owner)
          }
          return browser.selectAttachment({
            uiTabId: asString(params.uiTabId, 'uiTabId'),
            threadId: asString(params.threadId, 'threadId')
          }, owner)
        } catch (error) { rpc(error) }
      }
    })
  }

  for (const method of BROWSER_GUI_METHODS) {
    domains.register({
      method,
      scope: 'profile',
      capability: BROWSER_VIEWER_CAPABILITY,
      requiredCapabilities: [BROWSER_VIEWER_CAPABILITY],
      validate: (value) => domainObject(value ?? {}, ['profileId', ...GUI_FIELDS[method]]),
      async handle(context, params, binding) {
        try {
          const owner = requireGui(context)
          if (binding && binding.profileId !== owner.profileId) throw new DomainRpcError('profile_mismatch', 'Browser request does not match the connection binding')
          const browser = await resolve(owner.profileId)
          const threadId = asString(params.threadId, 'threadId')
          const sessionId = asString(params.sessionId, 'sessionId')
          // A kept session (a bot's browser) is never listed here; named, it is refused in plain words.
          const selected = browser.listPublicSessions(threadId).find((record) => record.id === sessionId)
          const kept = !selected ? browser.sessions.keptRefusal(sessionId) : undefined
          if (kept) throw new DomainRpcError('policy_denied', kept)
          if (!selected) throw new DomainRpcError('session_closed', 'Browser session is unavailable')
          const scope = browser.sessions.trustedSessionScope({ profileId: owner.profileId, threadId, sessionId: selected.id })
          const viewContext = viewerContext(owner.profileId, scope.threadId, scope.runId, viewerPolicy(owner.profileId))
          try {
            if (method === 'browser.artifacts.read') {
              assertAttachedOwner(browser, selected.id, selected.backend, owner.connectionId)
              const artifactId = asString(params.artifactId, 'artifactId', 160)
              const bound = Math.min(viewContext.policy.maxArtifactBytes, MAX_BROWSER_ARTIFACT_READ_BYTES)
              const file = await browser.artifacts.read({
                profileId: owner.profileId,
                threadId: scope.threadId,
                sessionId: selected.id,
                ...(scope.runId === undefined ? {} : { runId: scope.runId })
              }, artifactId, bound)
              if (file.ref.mediaType !== 'image/png') throw new DomainRpcError('artifact_denied', 'Browser artifact reads are limited to authorized PNG screenshots')
              return {
                artifact: { ...file.ref },
                mediaType: file.ref.mediaType,
                byteLength: file.bytes.byteLength,
                bytesBase64: Buffer.from(file.bytes).toString('base64')
              } satisfies BrowserArtifactReadResult
            }
            // Take control and Resume belong to the in-app tab; a browser without a window has one hold rule, its view's.
            if (selected.backend !== 'electron-attached') throw new DomainRpcError('policy_denied', WINDOWLESS_REFUSAL)
            assertAttachedOwner(browser, selected.id, selected.backend, owner.connectionId)
            if (method === 'browser.sessions.takeControl') await browser.sessions.control(viewContext, selected.id, 'human')
            else {
              await browser.sessions.control(viewContext, selected.id, 'agent')
              // A fresh generation fences input made before the agent had the tab again, without needing a screenshot.
              await browser.sessions.observe({ ...viewContext, vision: false }, { sessionId: selected.id, includeScreenshot: false })
            }
            // The session as a window may see it: never its control lease.
            const session: BrowserSessionPublicRecord = browser.listPublicSessions(threadId).find((record) => record.id === selected.id) ?? selected
            return { session }
          } finally {
            browser.sessions.retireViewerBudget(viewContext)
          }
        } catch (error) { rpc(error) }
      }
    })
  }

  return {
    dispose() {
      disposed = true
      closed()
      known.clear()
    }
  }
}

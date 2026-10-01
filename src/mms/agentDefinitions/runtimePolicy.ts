import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { AgentDefinitionError } from '../../shared/agents/errors'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import type {
  AgentExecutionSource,
  AgentRuntimeHostBindings,
  AgentRuntimePolicy,
  AgentRuntimeToolApprovalCallback,
  AgentRuntimeToolApprovalDecision,
  AgentRuntimeToolApprovalRequest,
  AgentRuntimeToolClassification,
  AgentRuntimeUnsupportedSetting
} from '../../shared/agents/execution'
import type {
  AgentDefinitionSettings,
  EffectiveAgentGrants,
  ResolvedAgentDefinition
} from '../../shared/agents/types'
import { normalizeOsPath } from '../orchestrator/toolPathSafety'
import { BROWSER_READ_TOOLS, isBrowserAutomationTool } from '../orchestrator/browser/tools'
import { browserRuntimeHostBindingMessage, readHostBrowserRuntime } from '../orchestrator/browser/binding'

/** Legacy Mousse build-tool names → canonical built-in ids. Keep aligned with LlmClient. */
export const BUILTIN_TOOL_ALIASES: Readonly<Record<string, string>> = {
  read_file: 'read',
  write_file: 'write',
  list_dir: 'ls',
  run_command: 'bash'
}

const READ_FS_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'git_status', 'git_diff'])
const WRITE_FS_TOOLS = new Set(['write', 'edit'])
const SCRIPT_TOOLS = new Set(['bash'])
const ASK_TOOLS = new Set(['ask_user', 'present_plan'])
const PATH_ARG_KEYS = ['path', 'file_path', 'filePath', 'directory', 'dir'] as const
const SUPPORTED_WORKSPACE_INTERPRETERS = new Set(['bash', 'sh', 'shell', 'powershell', 'pwsh', 'cmd'])

export function canonicalizeBuiltinToolName(name: string): string {
  return BUILTIN_TOOL_ALIASES[name] ?? name
}

export function classifyTrustedTool(toolName: string, isMcp: boolean): AgentRuntimeToolClassification {
  if (isMcp) return 'mcp'
  const canonical = canonicalizeBuiltinToolName(toolName)
  if (ASK_TOOLS.has(canonical)) return 'ask'
  if (SCRIPT_TOOLS.has(canonical)) return 'script'
  if (WRITE_FS_TOOLS.has(canonical)) return 'write'
  if (READ_FS_TOOLS.has(canonical)) return 'read'
  if (isBrowserAutomationTool(canonical) && BROWSER_READ_TOOLS.has(canonical)) return 'read'
  return 'other'
}

export function isFilesystemTool(classification: AgentRuntimeToolClassification): boolean {
  return classification === 'read' || classification === 'write' || classification === 'script'
}

export function isUnattendedSource(source: AgentExecutionSource): boolean {
  return source === 'schedule' || source === 'channel'
}

export function resolveExistingCanonical(pathValue: string): string {
  const resolved = resolve(normalizeOsPath(pathValue))
  return existsSync(resolved) ? realpathSync(resolved) : resolved
}

export function pathInsideCanonicalRoots(
  target: string,
  roots: readonly string[]
): { ok: true; canonical: string } | { ok: false; reason: string } {
  if (roots.length === 0) {
    return { ok: false, reason: 'No canonical workspace roots are bound by the host.' }
  }
  const resolvedTarget = resolve(normalizeOsPath(target))
  let existingAncestor = resolvedTarget
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const canonicalAncestor = existsSync(existingAncestor) ? realpathSync(existingAncestor) : existingAncestor
  const suffix = relative(existingAncestor, resolvedTarget)
  const canonicalTarget = !suffix || suffix === '' ? canonicalAncestor : resolve(canonicalAncestor, suffix)

  for (const root of roots) {
    const canonicalRoot = resolveExistingCanonical(root)
    const relTarget = relative(canonicalRoot, canonicalTarget)
    const contained =
      relTarget === '' || (relTarget !== '..' && !relTarget.startsWith(`..${sep}`) && !isAbsolute(relTarget))
    if (contained) {
      return { ok: true, canonical: canonicalTarget }
    }
  }
  return { ok: false, reason: `Path escaped allowed workspace roots: ${target}` }
}

export function extractToolPathArguments(args: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) paths.push(value.trim())
  }
  const listed = args.paths
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (typeof entry === 'string' && entry.trim()) paths.push(entry.trim())
    }
  }
  return paths
}

export function digestToolArguments(args: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(args ?? {}))
}

function intersectPermittedRoots(hostRoots: string[], permittedRoots: string[]): string[] {
  if (permittedRoots.length === 0) return hostRoots
  const allowed: string[] = []
  for (const permitted of permittedRoots) {
    const resolvedPermitted = resolve(normalizeOsPath(permitted))
    const inside = pathInsideCanonicalRoots(resolvedPermitted, hostRoots)
    if (inside.ok) allowed.push(inside.canonical)
  }
  return allowed
}

function collectHostRoots(
  settings: AgentDefinitionSettings,
  host: AgentRuntimeHostBindings | undefined,
  _projectPath: string | undefined
): string[] {
  const supplied: string[] = []
  if (host?.workspaceRoots?.length) {
    for (const root of host.workspaceRoots) {
      if (typeof root === 'string' && root.trim()) supplied.push(resolveExistingCanonical(root.trim()))
    }
  }
  if (settings.workspace.mode === 'dedicated_child_worktree' && host?.dedicatedWorktreeRoot?.trim()) {
    supplied.push(resolveExistingCanonical(host.dedicatedWorktreeRoot.trim()))
  }
  const unique = [...new Set(supplied)]
  return intersectPermittedRoots(unique, settings.workspace.permittedRoots)
}

export function collectUnsupportedRuntimeSettings(
  resolved: ResolvedAgentDefinition,
  host: AgentRuntimeHostBindings | undefined
): AgentRuntimeUnsupportedSetting[] {
  const settings = resolved.settings
  const unsupported: AgentRuntimeUnsupportedSetting[] = []
  const native = resolved.runtimeKind === 'mousse'

  if (settings.browser.mode !== 'disabled') {
    if (!native) {
      unsupported.push({
        pointer: '/settings/browser/mode',
        reason: 'CLI adapters do not receive native browser tool dispatch.',
        hostBinding: 'CLI permission/config materializers must not claim a managed browser worker; that work is outside this runtime.'
      })
    } else if (!readHostBrowserRuntime(host)) {
      unsupported.push({
        pointer: '/settings/browser/mode',
        reason: 'Browser mode requires an injected BrowserRuntimePort before provider dispatch.',
        hostBinding: browserRuntimeHostBindingMessage()
      })
    } else if (settings.browser.mode !== 'structured') {
      unsupported.push({
        pointer: '/settings/browser/mode',
        reason:
          'This runtime implements the eight generic BROWSER_AUTOMATION_TOOLS for structured mode only. Native/hybrid computer-use and vision adapters are not bound.',
        hostBinding: 'Root must keep /settings/browser/mode at "structured" for this generic tool loop, or bind a qualified computer-use adapter separately.'
      })
    }
    if (native && settings.browser.workspaceId) {
      unsupported.push({
        pointer: '/settings/browser/workspaceId',
        reason: 'Persistent browser workspaces are not implemented by this native runtime.',
        hostBinding: 'Root must omit workspaceId; attached GUI tabs retain existing storage, and managed persistence is not claimed here.'
      })
    }
    if (native && settings.browser.traceRetention !== 'none') {
      unsupported.push({
        pointer: '/settings/browser/traceRetention',
        reason: 'Browser trace retention is not implemented by this native runtime.',
        hostBinding: 'Keep /settings/browser/traceRetention at "none" until a profile-owned trace store is bound.'
      })
    }
  }
  if (settings.delegation.maxConcurrentChildren > 0) {
    unsupported.push({
      pointer: '/settings/delegation/maxConcurrentChildren',
      reason: 'Child agent delegation is not implemented by this runtime.',
      hostBinding: 'Root must bind a bounded child-definition runner before allowing concurrent children.'
    })
  }
  if (settings.delegation.maxDepth > 0) {
    unsupported.push({
      pointer: '/settings/delegation/maxDepth',
      reason: 'Child agent delegation is not implemented by this runtime.',
      hostBinding: 'Root must bind a bounded child-definition runner before allowing nested depth.'
    })
  }
  if (settings.delegation.allowedChildDefinitionIds.length > 0) {
    unsupported.push({
      pointer: '/settings/delegation/allowedChildDefinitionIds',
      reason: 'Child agent delegation is not implemented by this runtime.',
      hostBinding: 'Root must bind an allowed-child definition runner.'
    })
  }
  if (settings.script.enabled && settings.script.executionMode === 'sandboxed') {
    unsupported.push({
      pointer: '/settings/script/executionMode',
      reason: 'No sandbox implementation is available in this runtime.',
      hostBinding: 'Root must bind an OS sandbox before sandboxed script execution can be enabled.'
    })
  }
  if (settings.script.enabled && settings.script.allowNetwork) {
    unsupported.push({
      pointer: '/settings/script/allowNetwork',
      reason: 'Network isolation for script execution is not implemented.',
      hostBinding: 'Root must bind a network policy enforcer before allowNetwork can be enabled.'
    })
  }
  if (settings.script.enabled && settings.script.interpreters.length > 0) {
    const unsupportedInterpreters = settings.script.interpreters.filter(
      (interpreter) => !SUPPORTED_WORKSPACE_INTERPRETERS.has(interpreter.trim().toLowerCase())
    )
    if (unsupportedInterpreters.length > 0) {
      unsupported.push({
        pointer: '/settings/script/interpreters',
        reason: `Script interpreters are not implemented: ${unsupportedInterpreters.join(', ')}.`,
        hostBinding: 'Root must bind additional interpreters; this runtime only executes the built-in bash tool in workspace mode.'
      })
    }
  }
  if (settings.recovery.stopCondition) {
    unsupported.push({
      pointer: '/settings/recovery/stopCondition',
      reason: 'Custom recovery stop conditions are not implemented.',
      hostBinding: 'Root must bind a stop-condition evaluator.'
    })
  }
  if (settings.recovery.finalReportTemplate) {
    unsupported.push({
      pointer: '/settings/recovery/finalReportTemplate',
      reason: 'Recovery final-report templates are not implemented.',
      hostBinding: 'Root must bind a final-report renderer.'
    })
  }
  if (
    native &&
    settings.fallbacks.enabled &&
    resolved.model.fallbacks.length > 0 &&
    !settings.fallbacks.allowHigherCost
  ) {
    unsupported.push({
      pointer: '/settings/fallbacks/allowHigherCost',
      reason: 'Resolved model capabilities do not include price data, so this runtime cannot prove that a fallback is no more expensive than the primary model.',
      hostBinding: 'Root must supply cost-qualified fallback models or explicitly allow higher-cost fallbacks.'
    })
  }
  if (settings.workspace.mode === 'dedicated_child_worktree' && !host?.dedicatedWorktreeRoot?.trim()) {
    unsupported.push({
      pointer: '/settings/workspace/mode',
      reason: 'dedicated_child_worktree requires a host-supplied dedicated worktree root.',
      hostBinding: 'AgentRuntimeHostBindings.dedicatedWorktreeRoot'
    })
  }
  if (settings.approval.policy === 'always' && !host?.approveToolRequest) {
    unsupported.push({
      pointer: '/settings/approval/policy',
      reason: 'approval.policy "always" requires a host approval callback; auto-approve is never defaulted.',
      hostBinding: 'AgentRuntimeHostBindings.approveToolRequest'
    })
  }
  if (!native) {
    if (settings.fallbacks.enabled) {
      unsupported.push({
        pointer: '/settings/fallbacks/enabled',
        reason: 'CLI process adapters do not implement model fallback or aggregate retry accounting.',
        hostBinding: 'A qualified CLI coordinator must select and account for fallback attempts before enabling this setting.'
      })
    }
    if (settings.workspace.mode === 'read_only') {
      unsupported.push({
        pointer: '/settings/workspace/mode',
        reason: 'CLI adapters do not receive native tool-dispatch enforcement for read-only workspace policy.',
        hostBinding: 'CLI permission/config materializers must enforce workspace mode; that work is outside this runtime.'
      })
    }
    if (settings.script.enabled) {
      unsupported.push({
        pointer: '/settings/script/enabled',
        reason: 'CLI adapters do not receive native script-dispatch enforcement.',
        hostBinding: 'CLI permission/config materializers must enforce script policy; that work is outside this runtime.'
      })
    }
    if (settings.approval.policy !== 'inherit') {
      unsupported.push({
        pointer: '/settings/approval/policy',
        reason: 'CLI adapters do not receive native approval-dispatch enforcement.',
        hostBinding: 'CLI permission/config materializers must enforce approval policy; that work is outside this runtime.'
      })
    }
  }
  return unsupported
}

export function assertRuntimeSettingsSupported(
  resolved: ResolvedAgentDefinition,
  host: AgentRuntimeHostBindings | undefined
): void {
  const unsupported = collectUnsupportedRuntimeSettings(resolved, host)
  if (unsupported.length === 0) return
  throw new AgentDefinitionError(
    'SETTINGS_UNSUPPORTED',
    `Agent runtime cannot authoritatively implement ${unsupported.map((item) => item.pointer).join(', ')}.`,
    {
      details: {
        pointers: unsupported.map((item) => item.pointer),
        reasons: Object.fromEntries(unsupported.map((item) => [item.pointer, item.reason])),
        hostBindings: Object.fromEntries(
          unsupported
            .filter((item) => item.hostBinding)
            .map((item) => [item.pointer, item.hostBinding])
        )
      }
    }
  )
}

export function compileRuntimePolicy(input: {
  resolved: ResolvedAgentDefinition
  runId: string
  threadId: string
  source: AgentExecutionSource
  projectPath?: string
  host?: AgentRuntimeHostBindings
}): AgentRuntimePolicy {
  const { resolved, host, projectPath } = input
  const settings = resolved.settings
  return deepFreeze({
    profileId: resolved.profileId,
    threadId: input.threadId,
    runId: input.runId,
    definitionId: resolved.definitionId,
    definitionRevision: resolved.revision,
    source: input.source,
    workspace: {
      mode: settings.workspace.mode,
      canonicalRoots: collectHostRoots(settings, host, projectPath)
    },
    script: {
      enabled: settings.script.enabled,
      allowFilesystem: settings.script.allowFilesystem,
      allowNetwork: settings.script.allowNetwork,
      executionMode: settings.script.executionMode,
      interpreters: [...settings.script.interpreters]
    },
    approval: {
      askUser: settings.approval.askUser,
      policy: settings.approval.policy,
      unattendedBehavior: settings.approval.unattendedBehavior
    },
    memoryScope: settings.memory.scope,
    includeCurrentThread: settings.context.includeCurrentThread,
    includeProjectInstructions: settings.context.includeProjectInstructions,
    attachmentPolicy: settings.context.attachmentPolicy,
    maxContextTokens: settings.context.maxContextTokens,
    fallbacks: {
      enabled: settings.fallbacks.enabled,
      retryOn: [...settings.fallbacks.retryOn],
      allowHigherCost: settings.fallbacks.allowHigherCost,
      retryCount: settings.recovery.retryCount,
      backoffMs: settings.recovery.backoffMs
    },
    fallbackModels: structuredClone(resolved.model.fallbacks)
  })
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export function isToolPermittedByPolicy(
  toolName: string,
  policy: AgentRuntimePolicy | undefined,
  isMcp = false
): boolean {
  if (!policy) return true
  const classification = classifyTrustedTool(toolName, isMcp)
  const canonical = canonicalizeBuiltinToolName(toolName)
  if (!policy.approval.askUser && canonical === 'ask_user') return false
  if (policy.workspace.mode === 'read_only' && (classification === 'write' || classification === 'script')) {
    return false
  }
  if (!policy.script.enabled && classification === 'script') return false
  if (policy.script.enabled && !policy.script.allowFilesystem && classification === 'script') return false
  return true
}

export interface TrustedToolDispatchPreparation {
  allowed: boolean
  message?: string
  needsApproval: boolean
  classification: AgentRuntimeToolClassification
  canonicalToolName: string
  workspacePaths: string[]
  argumentDigest: string
  approvalRequest?: AgentRuntimeToolApprovalRequest
}

export function prepareTrustedToolDispatch(input: {
  policy: AgentRuntimePolicy
  grants: EffectiveAgentGrants
  toolName: string
  args: Record<string, unknown>
  isMcp: boolean
  projectPath?: string
}): TrustedToolDispatchPreparation {
  const canonicalToolName = canonicalizeBuiltinToolName(input.toolName)
  const classification = classifyTrustedTool(input.toolName, input.isMcp)
  const argumentDigest = digestToolArguments(input.args)
  const rawPaths = extractToolPathArguments(input.args)
  const workspacePaths: string[] = []
  const deny = (message: string): TrustedToolDispatchPreparation => ({
    allowed: false,
    message,
    needsApproval: false,
    classification,
    canonicalToolName,
    workspacePaths,
    argumentDigest
  })

  if (!isToolPermittedByPolicy(input.toolName, input.policy, input.isMcp)) {
    if (!input.policy.approval.askUser && canonicalToolName === 'ask_user') {
      return deny('ask_user is disabled by /settings/approval/askUser.')
    }
    if (input.policy.workspace.mode === 'read_only' && (classification === 'write' || classification === 'script')) {
      return deny(
        `Workspace is read-only; ${canonicalToolName} is blocked by /settings/workspace/mode.`
      )
    }
    if (classification === 'script') {
      if (!input.policy.script.enabled) {
        return deny('Script execution is disabled by /settings/script/enabled.')
      }
      if (!input.policy.script.allowFilesystem) {
        return deny('Script filesystem access is disabled by /settings/script/allowFilesystem.')
      }
    }
    return deny(`Tool "${canonicalToolName}" is not permitted by the compiled runtime policy.`)
  }

  if (classification === 'script' && input.policy.script.executionMode !== 'workspace') {
    return deny('Sandboxed script execution is not implemented; refusing dispatch.')
  }

  if (isFilesystemTool(classification) && !isBrowserAutomationTool(canonicalToolName)) {
    const cwd = input.projectPath
    if (!cwd?.trim()) {
      return deny('No project root selected for workspace tools.')
    }
    const cwdCheck = pathInsideCanonicalRoots(cwd, input.policy.workspace.canonicalRoots)
    if (!cwdCheck.ok) return deny(cwdCheck.reason)
    workspacePaths.push(cwdCheck.canonical)
    for (const rawPath of rawPaths) {
      const absolute = isAbsolute(normalizeOsPath(rawPath))
        ? resolve(normalizeOsPath(rawPath))
        : resolve(normalizeOsPath(cwd), normalizeOsPath(rawPath))
      const check = pathInsideCanonicalRoots(absolute, input.policy.workspace.canonicalRoots)
      if (!check.ok) return deny(check.reason)
      workspacePaths.push(check.canonical)
    }
  }

  const unattended = isUnattendedSource(input.policy.source)
  const mutating = classification === 'write' || classification === 'script' || classification === 'mcp' || classification === 'other'
  if (unattended && mutating) {
    if (input.policy.approval.policy === 'unattended_deny' || input.policy.approval.policy === 'unattended_allow_readonly') {
      return deny(`Unattended ${classification} dispatch is denied by /settings/approval/policy.`)
    }
    if (input.policy.approval.policy === 'inherit') {
      if (input.policy.approval.unattendedBehavior === 'fail') {
        return deny('Unattended mutating tool dispatch failed by /settings/approval/unattendedBehavior.')
      }
      if (input.policy.approval.unattendedBehavior === 'skip') {
        return deny('Unattended mutating tool dispatch skipped by /settings/approval/unattendedBehavior.')
      }
    }
  }

  const needsApproval =
    input.policy.approval.policy === 'always' && classification !== 'ask'
    || (unattended && input.policy.approval.policy === 'inherit' && mutating && input.policy.approval.unattendedBehavior === 'pause')

  const approvalRequest: AgentRuntimeToolApprovalRequest = {
    runId: input.policy.runId,
    profileId: input.policy.profileId,
    threadId: input.policy.threadId,
    definitionId: input.policy.definitionId,
    definitionRevision: input.policy.definitionRevision,
    toolName: input.toolName,
    canonicalToolName,
    classification,
    arguments: structuredClone(input.args),
    argumentDigest,
    workspacePaths: [...workspacePaths]
  }

  return {
    allowed: true,
    needsApproval,
    classification,
    canonicalToolName,
    workspacePaths,
    argumentDigest,
    approvalRequest
  }
}

export async function authorizeTrustedToolDispatch(input: {
  prepared: TrustedToolDispatchPreparation
  policy: AgentRuntimePolicy
  grants: EffectiveAgentGrants
  toolName: string
  args: Record<string, unknown>
  isMcp: boolean
  projectPath?: string
  signal?: AbortSignal
  approveToolRequest?: AgentRuntimeToolApprovalCallback
}): Promise<{ allowed: true } | { allowed: false; message: string }> {
  const deny = (message: string) => ({ allowed: false as const, message })
  if (!input.prepared.allowed) return deny(input.prepared.message ?? 'Tool dispatch denied.')
  if (input.signal?.aborted) return deny('Tool dispatch cancelled before approval.')

  if (input.prepared.needsApproval) {
    if (!input.approveToolRequest) {
      return deny(
        'Tool dispatch requires host approval; auto-approve is never defaulted (/settings/approval/policy).'
      )
    }
    let removeAbort = (): void => undefined
    const abort = input.signal
      ? new Promise<AgentRuntimeToolApprovalDecision>((resolve) => {
          const onAbort = () => resolve({ status: 'cancelled', reason: 'Tool approval was cancelled.' })
          input.signal!.addEventListener('abort', onAbort, { once: true })
          removeAbort = () => input.signal!.removeEventListener('abort', onAbort)
          if (input.signal!.aborted) onAbort()
        })
      : undefined
    // Defer the callback until the abort listener is installed. A host callback
    // may synchronously cancel and then leave its own promise pending.
    const approval = Promise.resolve().then(() => input.approveToolRequest!(input.prepared.approvalRequest!))
    const decision = abort
      ? await Promise.race([approval, abort]).finally(removeAbort)
      : await approval
    if (input.signal?.aborted) return deny('Tool dispatch cancelled after approval wait.')
    if (decision.status === 'cancelled') {
      return deny(decision.reason ?? 'Tool approval was cancelled.')
    }
    if (decision.status !== 'approved') {
      return deny(decision.reason ?? 'Tool approval was denied.')
    }
    if (decision.digest !== input.prepared.argumentDigest) {
      return deny('Tool approval is stale; digest does not match the exact request.')
    }
  }

  const rechecked = prepareTrustedToolDispatch({
    policy: input.policy,
    grants: input.grants,
    toolName: input.toolName,
    args: input.args,
    isMcp: input.isMcp,
    projectPath: input.projectPath
  })
  if (!rechecked.allowed) return deny(rechecked.message ?? 'Tool dispatch failed revalidation.')
  if (rechecked.argumentDigest !== input.prepared.argumentDigest) {
    return deny('Tool request changed during approval; refusing stale dispatch.')
  }
  if (rechecked.workspacePaths.join('\0') !== input.prepared.workspacePaths.join('\0')) {
    return deny('Workspace paths changed during approval; refusing stale dispatch.')
  }
  if (input.signal?.aborted) return deny('Tool dispatch cancelled immediately before side effects.')
  return { allowed: true }
}

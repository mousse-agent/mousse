import type {
  NodeId,
  RpcId,
  StreamDescriptor,
  StreamHead,
  RpcArtifactRef,
  NetErrorCode
} from '../net'
import type { AgentExecutionBudget } from '../agents/execution'
export interface BridgeEntityRef {
  nodeId: NodeId
  entityId: string
}
export interface BridgeDispatchInput {
  repoId: string
  baseCommit: string
  agent: string
  prompt: string
  limits: AgentExecutionBudget
  inputBundle?: RpcArtifactRef
  fetch?: boolean
  push?: boolean
}
/** Images per message, as for local sends (MMS_PROTOCOL_MAX_IMAGES). */
export const REMOTE_MAX_ATTACHMENTS = 16
/** Base64 characters in one staged chunk; keeps each request well inside one 64 KiB frame. */
export const REMOTE_ATTACHMENT_CHUNK_CHARS = 48 * 1024
/** Base64 characters in one staged image (MMS_PROTOCOL_MAX_IMAGE_BASE64_CHARS). */
export const REMOTE_ATTACHMENT_MAX_CHARS = 3 * 1024 * 1024
export const REMOTE_ATTACHMENT_MIME = /^image\/(png|jpeg|gif|webp|bmp)$/
/** A remote send or queued message: text, optional chat mode, and images staged with `attachments.stage`. */
export interface BridgeChatInput {
  threadId: string
  content: string
  mode?: string | { type: 'skill'; skillId: string }
  attachments?: string[]
}
export interface BridgeRemoteParams {
  'projects.list': Record<string, never>
  'threads.list': {
    projectId?: string
  }
  'threads.get': {
    threadId: string
  }
  'threads.search': {
    query: string
    limit?: number
  }
  'thread.snapshot': {
    threadId: string
  }
  'threads.create': {
    name: string
    projectId?: string
    worktreeEnabled?: boolean
  }
  'projects.open': {
    /** Absolute path of an existing directory on the receiving machine. */
    path: string
  }
  'threads.rename': {
    threadId: string
    name: string
  }
  'threads.pin': {
    threadId: string
    pinned: boolean
  }
  'threads.settle': {
    threadId: string
    settled: boolean
  }
  'orchestrator.send': BridgeChatInput
  'queue.enqueue': BridgeChatInput
  'queue.list': {
    threadId: string
  }
  'queue.remove': {
    threadId: string
    itemId: string
  }
  'queue.reorder': {
    threadId: string
    /** Queued message ids in their new order. */
    orderedIds: string[]
  }
  'queue.promoteToSteer': {
    threadId: string
    itemId: string
  }
  'composer.options': {
    threadId?: string
  }
  'threads.setModel': {
    threadId: string
    model: { instanceId?: string; llmProvider?: string; model: string }
  }
  'attachments.stage': {
    /** Caller-chosen id the send names in `attachments`. */
    upload: string
    index: number
    total: number
    name: string
    mimeType: string
    /** One slice of the image's base64. */
    data: string
  }
  'orchestrator.steer': {
    threadId: string
    run: RpcId
    text: string
  }
  'orchestrator.abort': {
    threadId: string
    run: RpcId
  }
  'orchestrator.isTurnActive': {
    threadId: string
  }
  'orchestrator.contextUsage': {
    threadId: string
  }
  'orchestrator.pendingQuestions': {
    threadId: string
  }
  'orchestrator.answerQuestions': {
    threadId: string
    requestId: string
    answers: Record<string, string | string[]>
  }
  'orchestrator.dismissQuestions': {
    threadId: string
    requestId: string
  }
  'bridge.thread.open': {
    threadId: string
  }
  'bridge.artifacts.open': {
    forRpcId: RpcId
    forMethod: 'bridge.dispatch'
  }
  'bridge.dispatch': BridgeDispatchInput
}
export type BridgeMethod = keyof BridgeRemoteParams
export interface BridgeThreadOpenResult {
  descriptor: StreamDescriptor
  head: StreamHead
}
export interface BridgeHubRequestOptions {
  id?: RpcId
  idem?: string
  deadlineMs?: number
}
/** Options for `bridge.hub.create`: the request options plus how the new thread is set up. */
export interface BridgeHubCreateOptions extends BridgeHubRequestOptions {
  /** Run the thread in its own git worktree on the target machine. */
  worktreeEnabled?: boolean
}
export type BridgeHubRequestState =
  'prepared' | 'unknown' | 'completed' | 'failed' | 'cancelRequested'
export interface BridgeHubRequestStatus {
  id: RpcId
  original: RpcId
  target: NodeId
  method: BridgeMethod
  state: BridgeHubRequestState
  createdAt: number
  updatedAt: number
  error?: NetErrorCode
}
export const BRIDGE_HUB_LOCAL_METHODS = [
  'bridge.hub.projects',
  'bridge.hub.threads',
  'bridge.hub.get',
  'bridge.hub.search',
  'bridge.hub.create',
  'bridge.hub.openProject',
  'bridge.hub.composerOptions',
  'bridge.hub.setModel',
  'bridge.hub.stageAttachment',
  'bridge.hub.send',
  'bridge.hub.steer',
  'bridge.hub.abort',
  'bridge.hub.attach',
  'bridge.hub.detach',
  'bridge.hub.dispatch',
  'bridge.hub.result',
  'bridge.hub.cancel',
  'bridge.hub.requests'
] as const
export type BridgeHubLocalMethod = (typeof BRIDGE_HUB_LOCAL_METHODS)[number]
/** Trusted local ingress uses the already authenticated network capability. */
export const BRIDGE_HUB_LOCAL_CAPABILITY = 'net.v1'
export interface BridgeHubLocalParams {
  'bridge.hub.projects': {
    target: NodeId
  }
  'bridge.hub.threads': {
    target: NodeId
    projectId?: string
  }
  'bridge.hub.get': {
    ref: BridgeEntityRef
  }
  'bridge.hub.search': {
    target: NodeId
    query: string
    limit?: number
  }
  'bridge.hub.create': {
    target: NodeId
    name: string
    projectId?: string
    options?: BridgeHubCreateOptions
  }
  'bridge.hub.openProject': {
    target: NodeId
    /** Absolute path of an existing directory on the target machine. */
    path: string
    options?: BridgeHubRequestOptions
  }
  /** The models, modes and skills the target's composer offers (`composer.options`). */
  'bridge.hub.composerOptions': {
    target: NodeId
    threadId?: string
    options?: BridgeHubRequestOptions
  }
  'bridge.hub.setModel': {
    ref: BridgeEntityRef
    model: BridgeRemoteParams['threads.setModel']['model']
    options?: BridgeHubRequestOptions
  }
  /** One base64 slice of an image the next `bridge.hub.send` names in `attachments`. */
  'bridge.hub.stageAttachment': BridgeRemoteParams['attachments.stage'] & {
    target: NodeId
    options?: BridgeHubRequestOptions
  }
  'bridge.hub.send': {
    ref: BridgeEntityRef
    content: string
    /** Chat mode for this message, as `orchestrator.send` takes it. */
    mode?: BridgeChatInput['mode']
    /** Upload ids staged with `bridge.hub.stageAttachment`. */
    attachments?: string[]
    options?: BridgeHubRequestOptions
  }
  'bridge.hub.steer': {
    ref: BridgeEntityRef
    run: RpcId
    text: string
    options?: BridgeHubRequestOptions
  }
  'bridge.hub.abort': {
    ref: BridgeEntityRef
    run: RpcId
    options?: BridgeHubRequestOptions
  }
  'bridge.hub.attach': {
    ref: BridgeEntityRef
  }
  'bridge.hub.detach': {
    ref: BridgeEntityRef
  }
  'bridge.hub.dispatch': {
    target: NodeId
    input: BridgeDispatchInput
    options?: BridgeHubRequestOptions
  }
  'bridge.hub.result': {
    id: RpcId
  }
  'bridge.hub.cancel': {
    id: RpcId
  }
  'bridge.hub.requests': {
    target?: NodeId
  }
}
export type BridgeHubThreadEvent = import('./display').BridgeDisplayPart
export const BRIDGE_HUB_THREAD_EVENT = 'bridge.hub.thread'

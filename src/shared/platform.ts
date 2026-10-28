import type { ChatMethod } from './chats'
import type { ChatResourceMethod } from './chatResources'
import type { WorkflowRunMethod } from './workflowRunPlatform'
import type { BrowserGuiMethod } from './browser/host'
import type { BrowserSetupMethod } from './browser/setup'
import type { BrowserAccessMethod } from './browser/access'
import type { ChatNetworkMethod } from './chatsNetwork'
import type { NetLocalMethod } from './net/local'
import type { BridgeHubLocalMethod } from './bridge/types'
import type { BridgeActivityMethod } from './bridge/deviceActivity'
import type { SpacesLocalMethod } from './spaces/local'
import type { BotsLocalMethod } from './bots/space/local'
import type { BotsPersonalMethod } from './bots/personal/methods'
import type { SpaceArchiveMethod } from './spaces/archive'
import type { SpeechHostMethod } from './speechRelay'

export type PlatformRequestMethod = ChatMethod | ChatResourceMethod | WorkflowRunMethod | BrowserGuiMethod | BrowserSetupMethod | BrowserAccessMethod
  | ChatNetworkMethod | NetLocalMethod | BridgeHubLocalMethod | BridgeActivityMethod | SpacesLocalMethod | BotsLocalMethod | SpaceArchiveMethod | SpeechHostMethod
  | BotsPersonalMethod
  | 'workflows.list' | 'workflows.get' | 'workflows.getRevision' | 'workflows.create'
  | 'workflows.saveDraft' | 'workflows.publish' | 'workflows.archive'
  | 'workflows.duplicate' | 'workflows.importBundle' | 'workflows.exportBundle'
  | 'workflows.validate' | 'workflows.listRevisions' | 'workflows.restoreRevision'
  | 'agentDefinitions.list' | 'agentDefinitions.get' | 'agentDefinitions.create'
  | 'agentDefinitions.saveDraft' | 'agentDefinitions.publish' | 'agentDefinitions.archive'
  | 'agentDefinitions.duplicate' | 'agentDefinitions.importBundle'
  | 'agentDefinitions.exportBundle' | 'agentDefinitions.validate' | 'agentDefinitions.tryRun'
  | 'agentDefinitions.tryRunPending' | 'agentDefinitions.tryRunAnswer'
  | 'integrations.snapshot' | 'chatReferences.resolve'
  | 'skills.create' | 'skills.update' | 'skills.editor' | 'skills.enable' | 'skills.archive'
  | 'skills.importPackage' | 'skills.exportPackage'
  | 'mcp.create' | 'mcp.update' | 'mcp.read' | 'mcp.enable' | 'mcp.delete'
  | 'mcp.testConnection' | 'mcp.beginAuth' | 'mcp.cancelAuth' | 'mcp.revokeAuth'
  | 'runs.resumeNow' | 'runs.cancelPause'

export type PlatformRequestErrorShape = import('./errors').AppErrorShape

export type PlatformResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: PlatformRequestErrorShape }

export interface PlatformRequestApi {
  request<T = unknown>(method: PlatformRequestMethod, params?: unknown): Promise<T>
}

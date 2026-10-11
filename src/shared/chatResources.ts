import type { BrowserViewerHumanAction, BrowserViewerSnapshot } from './browser/viewer'

/** People are reserved in the domain; the current UI admits agents and its owner. */
export interface ChatResourceParticipant {
  id: string
  kind: 'agent' | 'person'
  name: string
  color?: string
  definitionId?: string
  definitionRevision?: string
  deviceId?: string
}

export interface ChatResourceContext {
  profileId: string
  groupId: string
  clientId: string
  participantId: string
}

export type ChatResourceTarget =
  | { kind: 'browser'; id: string }
  | { kind: 'terminal'; id: string }
  | { kind: 'file'; id: string }

export type ChatResourceCursor =
  | { kind: 'browser'; tabId: string; generation: number; x: number; y: number }
  | { kind: 'terminal'; column: number; row: number }
  | { kind: 'file'; revision: string; line: number; column: number; endLine?: number; endColumn?: number }

export interface ChatResourcePresence {
  clientId: string
  participant: ChatResourceParticipant
  target: ChatResourceTarget
  cursor?: ChatResourceCursor
  updatedAt: number
  expiresAt: number
}

export interface ChatResourceControl {
  clientId: string
  participantId: string
  expiresAt: number
}

export interface ChatSharedTerminal {
  id: string
  threadId: string
  title: string
  alive: boolean
  columns: number
  rows: number
  control?: ChatResourceControl
}

export interface ChatTerminalOutput {
  sequence: number
  chunks: Array<{ sequence: number; data: string }>
  gap: boolean
  scrollback?: string
}

export interface ChatSharedFile {
  path: string
  content: string
  revision: string
}

export type ChatSharedFileWriteResult =
  | { status: 'saved'; file: ChatSharedFile }
  | { status: 'conflict'; file: ChatSharedFile }

export interface ChatResourceSnapshot {
  profileId: string
  groupId: string
  threadId: string
  viewerClientId: string
  browsers: BrowserViewerSnapshot[]
  browserControls: Record<string, ChatResourceControl>
  terminals: ChatSharedTerminal[]
  files: ChatSharedFile[]
  presence: ChatResourcePresence[]
  sequence: number
}

export type ChatResourceEvent = {
  profileId: string
  groupId: string
  sequence: number
  kind: 'presence' | 'browser' | 'terminal' | 'file'
  resourceId?: string
}

export type ChatSharedBrowserAction = BrowserViewerHumanAction

export const CHAT_RESOURCE_METHODS = [
  'chatResources.snapshot', 'chatResources.presence.update', 'chatResources.presence.leave',
  'chatResources.browser.open', 'chatResources.browser.observe', 'chatResources.browser.control',
  'chatResources.browser.action', 'chatResources.browser.close',
  'chatResources.terminal.create', 'chatResources.terminal.output', 'chatResources.terminal.control',
  'chatResources.terminal.write', 'chatResources.terminal.resize', 'chatResources.terminal.close',
  'chatResources.file.read', 'chatResources.file.write'
] as const

export type ChatResourceMethod = (typeof CHAT_RESOURCE_METHODS)[number]

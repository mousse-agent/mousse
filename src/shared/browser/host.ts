/**
 * Daemon browser host contract for root composition.
 * Viewer methods are the public GUI allowlist. Attachment methods are main-only
 * (GuiMmsController / trusted did-attach-webview), never a renderer platform API.
 */

import type { ArtifactReference } from '../execution/types'
import type { BrowserLifecycle, BrowserSessionRecord } from './types'
import type { BrowserViewerHumanAction, BrowserViewerSnapshot } from './viewer'

export const BROWSER_VIEWER_CAPABILITY = 'browser.viewer.v1' as const

export const BROWSER_GUI_METHODS = [
  'browser.sessions.list',
  'browser.sessions.get',
  'browser.sessions.observe',
  'browser.sessions.takeControl',
  'browser.sessions.resume',
  'browser.sessions.close',
  'browser.sessions.humanAction',
  'browser.artifacts.read'
] as const

export const BROWSER_ATTACHMENT_METHODS = [
  'browser.attachments.register',
  'browser.attachments.unregister',
  'browser.attachments.acknowledgeClosed',
  'browser.attachments.select'
] as const

export type BrowserGuiMethod = (typeof BROWSER_GUI_METHODS)[number]
export type BrowserAttachmentMethod = (typeof BROWSER_ATTACHMENT_METHODS)[number]
export type BrowserHostMethod = BrowserGuiMethod | BrowserAttachmentMethod

export const MAX_BROWSER_ATTACHMENTS_PER_CONNECTION = 128
export const MAX_BROWSER_ATTACHMENTS_PER_PROFILE = 512
/** PNG transfer bound for `browser.artifacts.read` (under the 4 MiB frame). */
export const MAX_BROWSER_ARTIFACT_READ_BYTES = 1_500_000

export interface BrowserAttachmentRegisterParams {
  registrationId: string
  registrationEpoch: number
  /** Main-generated before dispatch so ambiguous responses retain close proof. */
  closureToken: string
  uiTabId: string
  threadId?: string
}

export interface BrowserAttachmentUnregisterParams {
  registrationId: string
  registrationEpoch: number
}

export interface BrowserAttachmentAcknowledgeClosedParams extends BrowserAttachmentUnregisterParams {
  closureToken: string
}

export interface BrowserAttachmentSelectParams {
  uiTabId: string
  threadId: string
}

export interface BrowserAttachmentRegisterResult {
  uiTabId: string
  registrationId: string
  registrationEpoch: number
  profileId: string
  profileEpoch: number
  /** Opaque one-use guest-close proof. Main-only; never expose to renderer/model/logs. */
  closureToken: string
  /** Private worker staging root. Main-only; never copy into viewer/model DTOs. */
  artifactRoot: string
}

export interface BrowserSessionPublicRecord {
  id: string
  profileId: string
  threadId?: string
  runId?: string
  workspaceId?: string
  persistent: boolean
  backend: BrowserSessionRecord['backend']
  browserVersion: string
  generation: number
  lifecycle: BrowserLifecycle
  createdAt: string
  updatedAt: string
}

export interface BrowserSelectedTarget {
  backend: 'electron-attached'
  uiTabId: string
}

export interface BrowserSessionListResult {
  sessions: BrowserSessionPublicRecord[]
  selected?: BrowserSelectedTarget
}

export type BrowserSessionSnapshotResult = BrowserViewerSnapshot

export interface BrowserArtifactReadResult {
  artifact: ArtifactReference
  mediaType: string
  byteLength: number
  bytesBase64: string
}

export type { BrowserViewerHumanAction, BrowserViewerSnapshot }

/**
 * Root BrowserViewerClient adaptation:
 * - snapshot/history -> browser.sessions.get (and list)
 * - observe -> browser.sessions.observe
 * - takeControl -> browser.sessions.takeControl
 * - resumeAgent -> browser.sessions.resume
 * - close -> browser.sessions.close
 * - humanAction -> browser.sessions.humanAction
 * - artifactUrl -> browser.artifacts.read (bounded PNG base64; never a filesystem path)
 * subscribe remains a root-owned poll/event bridge; this daemon does not stream snapshots.
 */
export const BROWSER_VIEWER_CLIENT_METHODS = {
  snapshot: 'browser.sessions.get',
  observe: 'browser.sessions.observe',
  takeControl: 'browser.sessions.takeControl',
  resumeAgent: 'browser.sessions.resume',
  close: 'browser.sessions.close',
  humanAction: 'browser.sessions.humanAction',
  artifactRead: 'browser.artifacts.read'
} as const

import { randomUUID } from 'node:crypto'
import { fail } from '../../../browser-worker/errors'
import type {
  AttachedGuestDescriptor,
  AttachedGuestId,
  AttachedOwnerId,
  AttachedProfileEpoch,
  AttachedThreadBinding,
  AttachedUiTabId,
  TrustedOwnerBinding
} from '../../../shared/browser/attached'
import { profileBrowserPartition } from '../browserPolicy'
import type { GuestWebContentsHandle } from './guestHandle'

export interface TrustedGuestRecord {
  readonly guestId: AttachedGuestId
  readonly ownerId: AttachedOwnerId
  readonly uiTabId: AttachedUiTabId
  readonly profileId: string
  readonly profileEpoch: AttachedProfileEpoch
  thread: AttachedThreadBinding
  readonly guest: GuestWebContentsHandle
  readonly owner: GuestWebContentsHandle
}

export interface TrustedGuestRegistryOptions {
  expectedPartition?: (profileId: string) => string
  ownerBinding: TrustedOwnerBinding
}

export interface RegisterGuestInput {
  guest: GuestWebContentsHandle
  owner: GuestWebContentsHandle
  profileId: string
  profileEpoch: AttachedProfileEpoch
  uiTabId: AttachedUiTabId
  thread: AttachedThreadBinding
}

/**
 * Trusted main-only guest registry.
 * Callers must supply actual WebContents from did-attach-webview.
 * A renderer webContentsId is not an ownership proof.
 */
export class TrustedGuestRegistry {
  private readonly byUiTab = new Map<string, TrustedGuestRecord>()
  private readonly byGuestId = new Map<string, TrustedGuestRecord>()
  private readonly cleanups = new Map<string, Array<() => void>>()
  private readonly revokedListeners = new Set<(record: TrustedGuestRecord, reason: string) => void>()
  private readonly expectedPartition: (profileId: string) => string
  private readonly ownerBinding: TrustedOwnerBinding

  constructor(options: TrustedGuestRegistryOptions) {
    this.expectedPartition = options.expectedPartition ?? profileBrowserPartition
    this.ownerBinding = options.ownerBinding
  }

  /**
   * Intentionally absent: registerByWebContentsId.
   * Renderer-supplied numeric IDs cannot establish ownership.
   */
  registerGuest(input: RegisterGuestInput): AttachedGuestDescriptor {
    if (!input.guest || !input.owner) fail('invalid_action', 'Trusted guest registration requires actual WebContents handles')
    if (input.guest.isDestroyed() || input.owner.isDestroyed()) fail('session_closed', 'Cannot register a destroyed WebContents')
    const host = input.guest.hostWebContents()
    if (!host || host.nativeId !== input.owner.nativeId) {
      fail('policy_denied', 'Guest hostWebContents must be the trusted owner')
    }
    const expected = this.expectedPartition(input.profileId)
    if (!input.guest.session.matchesPartition(expected)) {
      fail('profile_mismatch', 'Guest partition does not match the bound profile')
    }
    if (!/^[a-zA-Z0-9:_-]+$/.test(input.uiTabId) || !/^[a-zA-Z0-9:_-]+$/.test(input.profileId) || !/^[a-zA-Z0-9:_-]+$/.test(input.profileEpoch)) {
      fail('invalid_action', 'Attached registration identifiers are invalid')
    }
    if (input.thread.kind === 'thread' && !/^[a-zA-Z0-9:_-]+$/.test(input.thread.threadId)) {
      fail('invalid_action', 'Attached thread identifier is invalid')
    }
    const existing = this.byUiTab.get(input.uiTabId)
    if (existing && existing.owner.nativeId !== input.owner.nativeId) {
      fail('policy_denied', 'Attached uiTabId is already owned by another window')
    }
    this.unregisterUiTab(input.uiTabId)
    const guestId = 'gst_' + randomUUID()
    const ownerId = 'own_' + randomUUID()
    const record: TrustedGuestRecord = {
      guestId,
      ownerId,
      uiTabId: input.uiTabId,
      profileId: input.profileId,
      profileEpoch: input.profileEpoch,
      thread: input.thread,
      guest: input.guest,
      owner: input.owner
    }
    this.byUiTab.set(input.uiTabId, record)
    this.byGuestId.set(guestId, record)
    const cleanups: Array<() => void> = []
    cleanups.push(input.guest.onDestroyed(() => {
      this.drop(record, 'guest-destroyed')
    }))
    cleanups.push(input.owner.onDestroyed(() => {
      this.drop(record, 'owner-destroyed')
    }))
    this.cleanups.set(guestId, cleanups)
    return this.descriptor(record)
  }

  assignThread(uiTabId: AttachedUiTabId, threadId: string): AttachedGuestDescriptor {
    if (!/^[a-zA-Z0-9:_-]+$/.test(threadId)) fail('invalid_action', 'Attached thread identifier is invalid')
    const record = this.requireUiTab(uiTabId)
    if (record.thread.kind === 'thread' && record.thread.threadId !== threadId) {
      fail('policy_denied', 'Attached tab is already bound to another thread; revoke and register it again')
    }
    record.thread = { kind: 'thread', threadId }
    return this.descriptor(record)
  }

  revokeUiTab(uiTabId: AttachedUiTabId): void {
    const record = this.byUiTab.get(uiTabId)
    if (record) this.drop(record, 'revoked')
  }

  revokeProfileEpoch(profileId: string, profileEpoch: AttachedProfileEpoch): TrustedGuestRecord[] {
    const dropped: TrustedGuestRecord[] = []
    for (const record of [...this.byUiTab.values()]) {
      if (record.profileId === profileId && record.profileEpoch !== profileEpoch) {
        dropped.push(record)
        this.drop(record, 'profile-epoch')
      }
    }
    return dropped
  }

  revokeOwnerNativeId(nativeId: number): TrustedGuestRecord[] {
    const dropped: TrustedGuestRecord[] = []
    for (const record of [...this.byUiTab.values()]) {
      if (record.owner.nativeId === nativeId) {
        dropped.push(record)
        this.drop(record, 'owner-closed')
      }
    }
    return dropped
  }

  lookup(uiTabId: AttachedUiTabId): TrustedGuestRecord | undefined {
    return this.byUiTab.get(uiTabId)
  }

  onRevoked(listener: (record: TrustedGuestRecord, reason: string) => void): () => void {
    this.revokedListeners.add(listener)
    return () => this.revokedListeners.delete(listener)
  }

  descriptorOf(uiTabId: AttachedUiTabId): AttachedGuestDescriptor {
    return this.descriptor(this.requireUiTab(uiTabId))
  }

  async assertDispatchAllowed(input: {
    uiTabId: AttachedUiTabId
    profileId: string
    profileEpoch?: AttachedProfileEpoch
    threadId?: string
  }): Promise<TrustedGuestRecord> {
    const record = this.byUiTab.get(input.uiTabId)
    if (!record) fail('session_closed', 'In-app tab is not registered for attached automation')
    if (record.guest.isDestroyed() || record.owner.isDestroyed()) {
      this.drop(record, 'destroyed')
      fail('session_closed', 'Attached guest or owner WebContents is gone')
    }
    const host = record.guest.hostWebContents()
    if (!host || host.nativeId !== record.owner.nativeId) {
      this.drop(record, 'host-mismatch')
      fail('policy_denied', 'Guest is no longer hosted by the trusted owner')
    }
    if (record.profileId !== input.profileId) fail('profile_mismatch', 'Attached tab is bound to a different profile')
    if (input.profileEpoch && record.profileEpoch !== input.profileEpoch) {
      fail('profile_mismatch', 'Attached tab profile epoch does not match')
    }
    const expected = this.expectedPartition(record.profileId)
    if (!record.guest.session.matchesPartition(expected)) {
      fail('profile_mismatch', 'Guest partition does not match the bound profile')
    }
    const bound = await this.ownerBinding({
      ownerId: record.ownerId,
      guestId: record.guestId,
      profileId: record.profileId,
      profileEpoch: record.profileEpoch,
      uiTabId: record.uiTabId
    })
    if (!bound) fail('policy_denied', 'Trusted owner binding is no longer valid')
    if (record.thread.kind === 'unbound') {
      fail('policy_denied', 'Unbound or pinned tab requires trusted thread assignment')
    }
    if (input.threadId && record.thread.threadId !== input.threadId) {
      fail('profile_mismatch', 'Attached tab is not authorized for this thread')
    }
    return record
  }

  clear(): void {
    for (const record of [...this.byUiTab.values()]) this.drop(record, 'cleared')
  }

  private requireUiTab(uiTabId: string): TrustedGuestRecord {
    const record = this.byUiTab.get(uiTabId)
    if (!record) fail('session_closed', 'In-app tab is not registered for attached automation')
    return record
  }

  private unregisterUiTab(uiTabId: string): void {
    const existing = this.byUiTab.get(uiTabId)
    if (existing) this.drop(existing, 'replaced')
  }

  private drop(record: TrustedGuestRecord, _reason: string): void {
    this.byUiTab.delete(record.uiTabId)
    this.byGuestId.delete(record.guestId)
    const cleanups = this.cleanups.get(record.guestId) ?? []
    this.cleanups.delete(record.guestId)
    for (const stop of cleanups) {
      try { stop() } catch { /* already gone */ }
    }
    for (const listener of this.revokedListeners) {
      try { listener(record, _reason) } catch { /* listener isolation */ }
    }
  }

  private descriptor(record: TrustedGuestRecord): AttachedGuestDescriptor {
    return {
      guestId: record.guestId,
      ownerId: record.ownerId,
      uiTabId: record.uiTabId,
      profileId: record.profileId,
      profileEpoch: record.profileEpoch,
      thread: record.thread
    }
  }
}

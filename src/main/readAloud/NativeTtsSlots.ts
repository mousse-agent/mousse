import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findLocalTtsModel, type KokoroTtsModel, type NativeSpeechResult } from '../../shared/readAloud'
import type { NativeTtsHostEvent, NativeTtsHostRequest } from './nativeTtsProtocol'

/**
 * Native read aloud slots: each slot is one host process (`nativeTtsHost.ts`) running Kokoro for
 * one window. A window opens a slot per read aloud worker it would otherwise start, sends it
 * segments, and closes it to stop a segment at once. Every call checks that the slot belongs to
 * the calling window, and arguments are checked here because the host trusts what main sends.
 */

/** The host process as the slots use it; `utilityProcess.fork` in the app. */
export interface NativeTtsProcess {
  postMessage(message: NativeTtsHostRequest): void
  on(event: 'message', listener: (message: NativeTtsHostEvent) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

/** The window a slot belongs to; a `WebContents` in the app. */
export interface NativeTtsOwner {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  on(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
  on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown
}

export interface NativeTtsSlotsOptions {
  /** Starts one host process. */
  fork: () => NativeTtsProcess
  /** The bytes of a file of a downloaded model; may fetch an optional voice first. */
  readFile: (modelId: string, path: string) => Promise<Uint8Array>
  isDownloaded: (modelId: string) => Promise<boolean>
}

/** Sent to the owner when a slot's process ends without being closed. */
export const NATIVE_SLOT_EXIT_CHANNEL = 'readAloud:nativeSlotExit'

/** A window runs two slots; replacing a stopped one briefly needs a third. */
export const MAX_SLOTS_PER_OWNER = 4
/** Segments are at most a few hundred characters. */
export const MAX_TEXT_CHARS = 1000
export const MAX_VOICE_CHARS = 64
export const MIN_SPEED = 0.5
export const MAX_SPEED = 2

interface Pending {
  resolve: (result: NativeSpeechResult) => void
  reject: (error: Error) => void
}

interface Slot {
  id: number
  owner: NativeTtsOwner
  model: KokoroTtsModel
  process: NativeTtsProcess
  /** Set until the model has loaded; the slot takes requests only after. */
  opening: { resolve: (slotId: number) => void; reject: (error: Error) => void } | null
  pending: Map<number, Pending>
}

/** The built host beside the bundle that runs this code (`out/main/nativeTtsHost.js`). */
export function nativeTtsHostScript(): string {
  const here = dirname(typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url))
  for (const dir of [here, join(here, '..')]) {
    const script = join(dir, 'nativeTtsHost.js')
    if (existsSync(script)) return script
  }
  return join(here, 'nativeTtsHost.js')
}

export class NativeTtsSlots {
  private readonly slots = new Map<number, Slot>()
  private readonly watched = new Set<number>()
  /** Bumped when an owner's page goes away (reload, crash), so opens started for that page give up. */
  private readonly generations = new Map<number, number>()
  private nextSlotId = 1
  private nextRequestId = 1

  constructor(private readonly options: NativeTtsSlotsOptions) {}

  /** Starts a host for `modelId` and resolves with its slot id once the model has loaded. */
  async open(owner: NativeTtsOwner, modelId: unknown): Promise<number> {
    const model = typeof modelId === 'string' ? findLocalTtsModel(modelId) : undefined
    if (!model || model.runtime !== 'kokoro') throw new Error('This voice model has no native engine')
    if (owner.isDestroyed()) throw new Error('The window is gone')
    // Watched before waiting, so a reload or crash during the wait is seen and no host is started
    // for a page that is gone.
    this.watch(owner)
    const generation = this.generationOf(owner)
    if (!(await this.options.isDownloaded(model.id))) throw new Error(`${model.label} is not downloaded. Download it under Settings, Speech.`)
    if (owner.isDestroyed() || this.generationOf(owner) !== generation) throw new Error('The window reloaded')
    if (this.slotsOf(owner).length >= MAX_SLOTS_PER_OWNER) throw new Error('Too many voice engines are running')

    const process = this.options.fork()
    const slot: Slot = { id: this.nextSlotId++, owner, model, process, opening: null, pending: new Map() }
    this.slots.set(slot.id, slot)
    const opened = new Promise<number>((resolve, reject) => {
      slot.opening = { resolve, reject }
    })
    process.on('message', (message) => this.onHostMessage(slot, message))
    process.on('exit', () => this.onHostExit(slot))
    process.postMessage({
      type: 'init',
      model: {
        id: model.id,
        repo: model.repo,
        dtype: model.dtype,
        defaultVoice: model.defaultVoice,
        voices: model.voices.map((voice) => voice.id),
        files: model.files.map((file) => file.path)
      }
    })
    return opened
  }

  /** Voices one segment. Resolves with `{ error }` when the host could not voice it; rejects when the slot stopped. */
  speak(owner: NativeTtsOwner, slotId: unknown, text: unknown, voice: unknown, speed: unknown): Promise<NativeSpeechResult> {
    const slot = this.ownedSlot(owner, slotId)
    if (slot.opening) throw new Error('The voice engine is still loading')
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS) {
      throw new Error(`Text must be 1 to ${MAX_TEXT_CHARS} characters`)
    }
    if (typeof voice !== 'string' || voice.length > MAX_VOICE_CHARS) throw new Error('Unknown voice')
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
      throw new Error(`Speed must be between ${MIN_SPEED} and ${MAX_SPEED}`)
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject })
      slot.process.postMessage({ type: 'speak', id, text, voice, speed })
    })
  }

  /** Kills the slot's process; its pending requests reject. */
  close(owner: NativeTtsOwner, slotId: unknown): void {
    this.stop(this.ownedSlot(owner, slotId), new Error('The voice engine was stopped'))
  }

  /** Kills every slot of `owner`. */
  closeAll(owner: NativeTtsOwner): void {
    for (const slot of this.slotsOf(owner)) this.stop(slot, new Error('The window closed'))
  }

  /** Number of running slots, for tests. */
  get size(): number {
    return this.slots.size
  }

  private ownedSlot(owner: NativeTtsOwner, slotId: unknown): Slot {
    const slot = typeof slotId === 'number' ? this.slots.get(slotId) : undefined
    if (!slot || slot.owner.id !== owner.id) throw new Error('This voice engine is not running')
    return slot
  }

  private generationOf(owner: NativeTtsOwner): number {
    return this.generations.get(owner.id) ?? 0
  }

  /** The owner's page went away: opens still waiting give up, and its slots are killed. */
  private pageGone(owner: NativeTtsOwner): void {
    this.generations.set(owner.id, this.generationOf(owner) + 1)
    this.closeAll(owner)
  }

  private slotsOf(owner: NativeTtsOwner): Slot[] {
    return [...this.slots.values()].filter((slot) => slot.owner.id === owner.id)
  }

  /** Slots end with their window: when it closes, its renderer crashes, or it reloads. */
  private watch(owner: NativeTtsOwner): void {
    if (this.watched.has(owner.id)) return
    this.watched.add(owner.id)
    owner.on('destroyed', () => {
      this.watched.delete(owner.id)
      this.generations.delete(owner.id)
      this.closeAll(owner)
    })
    owner.on('render-process-gone', () => this.pageGone(owner))
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.pageGone(owner)
    })
  }

  private stop(slot: Slot, error: Error): void {
    if (this.slots.get(slot.id) !== slot) return
    this.slots.delete(slot.id)
    slot.process.kill()
    slot.opening?.reject(error)
    slot.opening = null
    for (const pending of slot.pending.values()) pending.reject(error)
    slot.pending.clear()
  }

  private onHostMessage(slot: Slot, message: NativeTtsHostEvent): void {
    if (this.slots.get(slot.id) !== slot) return
    switch (message.type) {
      case 'ready':
        slot.opening?.resolve(slot.id)
        slot.opening = null
        return
      case 'load-error':
        this.stop(slot, new Error(message.message || 'The voice model could not be loaded'))
        return
      case 'file-request':
        void this.serveFile(slot, message.reqId, message.path)
        return
      case 'audio':
      case 'error': {
        const pending = slot.pending.get(message.id)
        if (!pending) return
        slot.pending.delete(message.id)
        if (message.type === 'error') pending.resolve({ error: String(message.message) })
        else if (message.samples instanceof Float32Array) pending.resolve({ samples: message.samples, sampleRate: message.sampleRate })
        else pending.resolve({ error: 'The voice engine sent no audio' })
      }
    }
  }

  private async serveFile(slot: Slot, reqId: number, path: string): Promise<void> {
    let response: NativeTtsHostRequest
    try {
      response = { type: 'file-response', reqId, bytes: await this.options.readFile(slot.model.id, path) }
    } catch (error) {
      response = { type: 'file-response', reqId, error: error instanceof Error ? error.message : 'Model file unavailable' }
    }
    if (this.slots.get(slot.id) === slot) slot.process.postMessage(response)
  }

  private onHostExit(slot: Slot): void {
    if (this.slots.get(slot.id) !== slot) return
    const opened = !slot.opening
    this.stop(slot, new Error('The voice engine stopped unexpectedly'))
    if (opened && !slot.owner.isDestroyed()) slot.owner.send(NATIVE_SLOT_EXIT_CHANNEL, { slotId: slot.id })
  }
}

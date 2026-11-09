import { findLocalTtsModel, type KokoroTtsModel, type NativeSpeechResult } from '../../shared/readAloud'
import type { KokoroInputs } from './kokoroText'
import { VoiceEngineReader, cancelFrame, loadFrame, runFrame, type VoiceEngineEvent } from './voiceEngineProtocol'

/**
 * Native read aloud slots. Every Kokoro model that is in use runs in one voice engine process
 * (`native/voice-engine`), which voices one segment at a time; a slot is one window's lane on it.
 * A window opens a slot, sends it segments, and cancels or closes it to stop a segment at once.
 * Text becomes the model's input here, in main (`kokoroText.ts`). Every call checks that the slot
 * belongs to the calling window, and arguments are checked here because the engine trusts what
 * main sends. The engine ends a short while after its last slot closed, so stopping a read and
 * starting another does not load the model again.
 */

/** The engine process as the slots use it; a child process in the app. */
export interface VoiceEngineProcess {
  write(bytes: Uint8Array): void
  onData(listener: (chunk: Uint8Array) => void): void
  /** Also called when the process could not start. */
  onExit(listener: () => void): void
  kill(): void
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
  /** Starts an engine; throws when there is none. */
  spawn: () => VoiceEngineProcess
  isDownloaded: (modelId: string) => Promise<boolean>
  /** Path of the downloaded model's ONNX file. */
  modelPath: (model: KokoroTtsModel) => Promise<string>
  /** Turns a segment into the model's input. */
  prepare: (model: KokoroTtsModel, text: string, voice: string) => Promise<KokoroInputs>
  /** How long an engine without slots keeps running. */
  idleMs?: number
}

/** Sent to the owner when the engine of an open slot ends without the slot being closed. */
export const NATIVE_SLOT_EXIT_CHANNEL = 'readAloud:nativeSlotExit'

/** A window runs one slot; a stopped read may briefly leave a second open. */
export const MAX_SLOTS_PER_OWNER = 4
/** Segments are at most a few hundred characters. */
export const MAX_TEXT_CHARS = 1000
export const MAX_VOICE_CHARS = 64
export const MIN_SPEED = 0.5
export const MAX_SPEED = 2
export const ENGINE_IDLE_MS = 15_000

/** What a cancelled segment resolves with; the window has already dropped it. */
export const CANCELLED_RESULT: NativeSpeechResult = { error: 'The segment was cancelled' }

interface Request {
  slot: Slot
  resolve: (result: NativeSpeechResult) => void
  reject: (error: Error) => void
  /** Set once the engine has it. */
  sent: boolean
  cancelled: boolean
}

interface Engine {
  model: KokoroTtsModel
  process: VoiceEngineProcess
  /** Settles once the model has loaded. */
  loaded: Promise<void>
  ready: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

interface Slot {
  id: number
  owner: NativeTtsOwner
  engine: Engine
  /** Until the model has loaded; the slot takes requests only after. */
  opening: boolean
  requests: Set<number>
}

export class NativeTtsSlots {
  private readonly slots = new Map<number, Slot>()
  private readonly engines = new Map<string, Engine>()
  private readonly requests = new Map<number, Request>()
  private readonly watched = new Set<number>()
  /** Bumped when an owner's page goes away (reload, crash), so opens started for that page give up. */
  private readonly generations = new Map<number, number>()
  private nextSlotId = 1
  private nextRequestId = 1

  constructor(private readonly options: NativeTtsSlotsOptions) {}

  /** Opens a slot on the engine for `modelId`, starting it if needed, and resolves with the slot id once the model has loaded. */
  async open(owner: NativeTtsOwner, modelId: unknown): Promise<number> {
    const model = typeof modelId === 'string' ? findLocalTtsModel(modelId) : undefined
    if (!model || model.runtime !== 'kokoro') throw new Error('This voice model has no native engine')
    if (owner.isDestroyed()) throw new Error('The window is gone')
    // Watched before waiting, so a reload or crash during the wait is seen and no slot is opened
    // for a page that is gone.
    this.watch(owner)
    const generation = this.generationOf(owner)
    const pageGone = (): boolean => owner.isDestroyed() || this.generationOf(owner) !== generation
    if (!(await this.options.isDownloaded(model.id))) throw new Error(`${model.label} is not downloaded. Download it under Settings, Speech.`)
    if (pageGone()) throw new Error('The window reloaded')
    if (this.slotsOf(owner).length >= MAX_SLOTS_PER_OWNER) throw new Error('Too many voice engines are running')

    const engine = this.engines.get(model.id) ?? (await this.startEngine(model))
    if (pageGone()) {
      this.idleCheck(engine)
      throw new Error('The window reloaded')
    }
    if (engine.idleTimer) clearTimeout(engine.idleTimer)
    engine.idleTimer = null
    const slot: Slot = { id: this.nextSlotId++, owner, engine, opening: true, requests: new Set() }
    this.slots.set(slot.id, slot)
    try {
      await engine.loaded
    } catch (error) {
      this.slots.delete(slot.id)
      throw error
    }
    // Closed meanwhile, or the page went away.
    if (this.slots.get(slot.id) !== slot) throw new Error('The voice engine was stopped')
    slot.opening = false
    return slot.id
  }

  /** Voices one segment. Resolves with `{ error }` when it could not be voiced or was cancelled; rejects when the slot stopped. */
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
      const request: Request = { slot, resolve, reject, sent: false, cancelled: false }
      this.requests.set(id, request)
      slot.requests.add(id)
      this.options.prepare(slot.engine.model, text, voice).then(
        (inputs) => {
          if (this.requests.get(id) !== request) return
          if (request.cancelled) return this.finish(id, CANCELLED_RESULT)
          let frame: Uint8Array
          try {
            frame = runFrame(id, inputs.inputIds, inputs.style, speed)
          } catch (error) {
            return this.finish(id, { error: errorMessage(error) })
          }
          request.sent = true
          slot.engine.process.write(frame)
        },
        (error: unknown) => {
          if (this.requests.get(id) === request) this.finish(id, request.cancelled ? CANCELLED_RESULT : { error: errorMessage(error) })
        }
      )
    })
  }

  /** Stops the slot's segments, also one being voiced; they resolve as cancelled. The slot stays open. */
  cancel(owner: NativeTtsOwner, slotId: unknown): void {
    const slot = this.ownedSlot(owner, slotId)
    for (const id of slot.requests) {
      const request = this.requests.get(id)
      if (!request || request.cancelled) continue
      request.cancelled = true
      if (request.sent) slot.engine.process.write(cancelFrame(id))
    }
  }

  /** Closes the slot: its segments stop and their calls reject. */
  close(owner: NativeTtsOwner, slotId: unknown): void {
    this.closeSlot(this.ownedSlot(owner, slotId), new Error('The voice engine was stopped'))
  }

  /** Closes every slot of `owner`. */
  closeAll(owner: NativeTtsOwner): void {
    for (const slot of this.slotsOf(owner)) this.closeSlot(slot, new Error('The window closed'))
  }

  /** Ends every engine, for quitting. */
  dispose(): void {
    for (const engine of [...this.engines.values()]) this.endEngine(engine, new Error('The app is quitting'), false)
  }

  /** Number of open slots, for tests. */
  get size(): number {
    return this.slots.size
  }

  /** Number of running engines, for tests. */
  get engineCount(): number {
    return this.engines.size
  }

  private async startEngine(model: KokoroTtsModel): Promise<Engine> {
    const path = await this.options.modelPath(model)
    // Another open may have started it meanwhile.
    const running = this.engines.get(model.id)
    if (running) return running
    const process = this.options.spawn()
    let settle!: { resolve: () => void; reject: (error: Error) => void }
    const loaded = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
    // Every open awaits it; this keeps a failed load from being reported as unhandled meanwhile.
    loaded.catch(() => undefined)
    const engine: Engine = { model, process, loaded, ready: false, idleTimer: null }
    this.engines.set(model.id, engine)
    const reader = new VoiceEngineReader()
    process.onData((chunk) => {
      if (this.engines.get(model.id) !== engine) return
      let events: VoiceEngineEvent[]
      try {
        events = reader.push(chunk)
      } catch (error) {
        this.endEngine(engine, new Error(errorMessage(error)), true)
        settle.reject(new Error(errorMessage(error)))
        return
      }
      for (const event of events) this.onEvent(engine, event, settle)
    })
    process.onExit(() => {
      if (this.engines.get(model.id) !== engine) return
      const error = new Error(engine.ready ? 'The voice engine stopped unexpectedly' : 'The voice engine did not start')
      this.endEngine(engine, error, true)
      settle.reject(error)
    })
    process.write(loadFrame(path))
    return engine
  }

  private onEvent(engine: Engine, event: VoiceEngineEvent, settle: { resolve: () => void; reject: (error: Error) => void }): void {
    switch (event.type) {
      case 'ready':
        engine.ready = true
        settle.resolve()
        return
      case 'load-error': {
        const error = new Error(event.message || 'The voice model could not be loaded')
        settle.reject(error)
        this.endEngine(engine, error, false)
        return
      }
      case 'audio':
        this.finish(event.id, { samples: event.samples, sampleRate: event.sampleRate })
        return
      case 'error':
        this.finish(event.id, { error: event.message || 'The voice engine could not voice this' })
        return
      case 'cancelled':
        this.finish(event.id, CANCELLED_RESULT)
    }
  }

  private finish(id: number, result: NativeSpeechResult): void {
    const request = this.requests.get(id)
    if (!request) return
    this.requests.delete(id)
    request.slot.requests.delete(id)
    request.resolve(request.cancelled && !('error' in result) ? CANCELLED_RESULT : result)
  }

  private closeSlot(slot: Slot, error: Error): void {
    if (this.slots.get(slot.id) !== slot) return
    this.slots.delete(slot.id)
    for (const id of slot.requests) {
      const request = this.requests.get(id)
      if (!request) continue
      this.requests.delete(id)
      if (request.sent) slot.engine.process.write(cancelFrame(id))
      request.reject(error)
    }
    slot.requests.clear()
    this.idleCheck(slot.engine)
  }

  /** Ends an engine that no slot uses once it has stayed unused for a while. */
  private idleCheck(engine: Engine): void {
    if (this.engines.get(engine.model.id) !== engine || engine.idleTimer) return
    if ([...this.slots.values()].some((slot) => slot.engine === engine)) return
    engine.idleTimer = setTimeout(() => {
      engine.idleTimer = null
      if (![...this.slots.values()].some((slot) => slot.engine === engine)) this.endEngine(engine, new Error('The voice engine was stopped'), false)
    }, this.options.idleMs ?? ENGINE_IDLE_MS)
  }

  /**
   * Kills the engine and stops its slots. `unexpected` tells the windows of open slots, which
   * then treat it like a crashed worker.
   */
  private endEngine(engine: Engine, error: Error, unexpected: boolean): void {
    if (this.engines.get(engine.model.id) !== engine) return
    this.engines.delete(engine.model.id)
    if (engine.idleTimer) clearTimeout(engine.idleTimer)
    engine.idleTimer = null
    engine.process.kill()
    for (const slot of [...this.slots.values()]) {
      if (slot.engine !== engine) continue
      const opened = !slot.opening
      this.slots.delete(slot.id)
      for (const id of slot.requests) {
        this.requests.get(id)?.reject(error)
        this.requests.delete(id)
      }
      slot.requests.clear()
      if (unexpected && opened && !slot.owner.isDestroyed()) slot.owner.send(NATIVE_SLOT_EXIT_CHANNEL, { slotId: slot.id })
    }
  }

  private ownedSlot(owner: NativeTtsOwner, slotId: unknown): Slot {
    const slot = typeof slotId === 'number' ? this.slots.get(slotId) : undefined
    if (!slot || slot.owner.id !== owner.id) throw new Error('This voice engine is not running')
    return slot
  }

  private generationOf(owner: NativeTtsOwner): number {
    return this.generations.get(owner.id) ?? 0
  }

  /** The owner's page went away: opens still waiting give up, and its slots close. */
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
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

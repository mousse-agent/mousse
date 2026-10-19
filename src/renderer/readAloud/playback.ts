import type { AudioLevels } from '../speech/audioLevels'

/** Pause state shared by the read aloud store and the engine that is playing. */
export class PauseGate {
  private readonly listeners = new Set<(paused: boolean) => void>()
  private value = false

  get paused(): boolean {
    return this.value
  }

  set(paused: boolean): void {
    if (this.value === paused) return
    this.value = paused
    for (const listener of [...this.listeners]) listener(paused)
  }

  /** Calls `listener` on every change; returns the unsubscribe function. */
  subscribe(listener: (paused: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolves when playback is not paused (at once if it is not), or when `signal` aborts. */
  whenPlaying(signal: AbortSignal): Promise<void> {
    if (!this.value || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        unsubscribe()
        signal.removeEventListener('abort', done)
        resolve()
      }
      const unsubscribe = this.subscribe((paused) => {
        if (!paused) done()
      })
      signal.addEventListener('abort', done)
    })
  }
}

export interface SpeakOptions {
  signal: AbortSignal
  /** Called once when audio starts coming out of the speakers. */
  onPlaying: () => void
  /** Voice name for the model; the model's default when undefined. */
  voice: string | undefined
  /** Read for each piece of audio, so a change in Settings applies from the next piece. */
  speed: () => number
  pause: PauseGate
  /** Receives the loudness of the audio as it plays, for the sound wave. */
  onLevels: (levels: AudioLevels) => void
}

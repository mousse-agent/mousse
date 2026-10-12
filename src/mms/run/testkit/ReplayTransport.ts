import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

/**
 * Adapter-boundary record/replay (docs/run-engine/SPEC.md §13.6). A transcript is NDJSON: a header
 * line, then one frame per line. `out` frames are what Mousse sent across the boundary, `in` frames
 * what the provider sent back, and `cue` frames mark where the user acted (steer, stop) relative to
 * the provider's stream. Replay asserts every outbound frame structurally and plays inbound frames
 * in order; a mismatch, a stall or an unconsumed frame fails with a readable report.
 */

export const TRANSCRIPT_VERSION = 1

export interface TranscriptHeader {
  kind: 'transcript'
  /** Adapter id the transcript was recorded through. */
  adapter: string
  scenario: string
  /** Which call boundary the frames describe (e.g. the SDK call or the wire protocol). */
  boundary: string
  /** ISO time of the recording, or `hand-authored`. */
  recordedAt: string
  version: number
}

export type FrameDirection = 'out' | 'in' | 'cue'

export interface TranscriptFrame {
  dir: FrameDirection
  frame: unknown
  /** Milliseconds since the recording started; informational, never replayed. */
  at?: number
}

export interface Transcript {
  header: TranscriptHeader
  frames: TranscriptFrame[]
}

export function parseTranscript(text: string, source = 'transcript'): Transcript {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`${source}:${index + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    }
  })
  const [header, ...frames] = parsed as [TranscriptHeader, ...TranscriptFrame[]]
  if (!header || header.kind !== 'transcript') throw new Error(`${source}: the first line must be a transcript header`)
  if (header.version !== TRANSCRIPT_VERSION)
    throw new Error(`${source}: transcript version ${header.version} is not ${TRANSCRIPT_VERSION}`)
  frames.forEach((frame, index) => {
    if (!frame || !['out', 'in', 'cue'].includes(frame.dir) || !('frame' in frame))
      throw new Error(`${source}:${index + 2}: expected { dir: 'out' | 'in' | 'cue', frame }`)
  })
  return { header, frames }
}

export function readTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, 'utf8'), path)
}

export function formatTranscript(transcript: Transcript): string {
  return [transcript.header, ...transcript.frames].map((line) => JSON.stringify(line)).join('\n') + '\n'
}

/** Builds a transcript while a real provider runs (record mode). */
export class TranscriptRecorder {
  private readonly frames: TranscriptFrame[] = []
  private readonly startedAt = Date.now()

  constructor(private readonly header: Omit<TranscriptHeader, 'kind' | 'version' | 'recordedAt'>) {}

  out(frame: unknown): void {
    this.push('out', frame)
  }

  in(frame: unknown): void {
    this.push('in', frame)
  }

  cue(frame: unknown): void {
    this.push('cue', frame)
  }

  transcript(): Transcript {
    return {
      header: {
        kind: 'transcript',
        ...this.header,
        recordedAt: new Date(this.startedAt).toISOString(),
        version: TRANSCRIPT_VERSION
      },
      frames: [...this.frames]
    }
  }

  write(path: string): void {
    writeFileSync(path, formatTranscript(this.transcript()))
  }

  private push(dir: FrameDirection, frame: unknown): void {
    // Snapshot now: providers mutate objects after handing them over.
    this.frames.push({ dir, frame: toJson(frame), at: Date.now() - this.startedAt })
  }
}

/** JSON round trip: drops `undefined`, functions and class identity. */
export function toJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Normaliser that removes the named keys at any depth after a JSON round trip. */
export function dropKeys(keys: Iterable<string>): (frame: unknown) => unknown {
  const drop = new Set(keys)
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).filter(([key]) => !drop.has(key)).map(([key, entry]) => [key, walk(entry)])
      )
    return value
  }
  return (frame) => walk(toJson(frame))
}

/** Volatile fields no boundary keeps stable between runs. */
export const DEFAULT_VOLATILE_KEYS = ['timestamp', 'at']

export interface ReplayOptions {
  /** Applied to both the recorded and the actual outbound frame before comparing. */
  normalize?: (frame: unknown) => unknown
  /** Performs a `cue` frame's user action; replay continues once it resolves. */
  onCue?: (cue: unknown) => Promise<void> | void
  /** How long a reader waits for another caller to send an expected outbound frame. */
  stallMs?: number
}

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayMismatchError'
  }
}

/** Replays a transcript at one adapter boundary. */
export class ReplayTransport {
  private cursor = 0
  private failure: ReplayMismatchError | undefined
  private readonly waiters = new Set<() => void>()
  private readers = 0
  private readonly normalize: (frame: unknown) => unknown
  private readonly stallMs: number

  constructor(
    readonly transcript: Transcript,
    private readonly options: ReplayOptions = {}
  ) {
    this.normalize = options.normalize ?? dropKeys(DEFAULT_VOLATILE_KEYS)
    this.stallMs = options.stallMs ?? 5_000
  }

  get header(): TranscriptHeader {
    return this.transcript.header
  }

  /** The adapter sent `frame`; it must equal the next transcript frame, which must be outbound. */
  send(frame: unknown): void {
    if (this.failure) throw this.failure
    const index = this.cursor
    const expected = this.transcript.frames[index]
    const actual = this.normalize(frame)
    if (!expected) this.fail(`Unexpected outbound frame after the end of the transcript:\n${pretty(actual)}`)
    if (expected.dir !== 'out')
      this.fail(
        `Frame ${index + 1}: the adapter sent a frame where the transcript has an ${expected.dir} frame.\n` +
          `transcript:\n${pretty(expected.frame)}\nsent:\n${pretty(actual)}`
      )
    const wanted = this.normalize(expected.frame)
    if (!isDeepStrictEqual(actual, wanted))
      this.fail(`Frame ${index + 1}: outbound frame differs from the transcript\n${lineDiff(wanted, actual)}`)
    this.advance()
  }

  /**
   * The next inbound frame. Cue frames run `onCue` on the way. An outbound frame for which
   * `isBoundary` holds ends this exchange (undefined); any other outbound frame belongs to another
   * caller, so the reader waits until it is sent. Undefined at the end of the transcript.
   */
  async receive(isBoundary?: (frame: unknown) => boolean): Promise<unknown> {
    this.readers += 1
    try {
      for (;;) {
        if (this.failure) throw this.failure
        const next = this.transcript.frames[this.cursor]
        if (!next) return undefined
        if (next.dir === 'in') {
          this.advance()
          return next.frame
        }
        if (next.dir === 'cue') {
          this.advance()
          try {
            await this.options.onCue?.(next.frame)
          } catch (error) {
            this.fail(`Cue ${pretty(next.frame)} failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          continue
        }
        if (isBoundary?.(next.frame)) return undefined
        await this.waitForAdvance(`Stalled at frame ${this.cursor + 1}: expected the adapter to send\n${pretty(next.frame)}`)
      }
    } finally {
      this.readers -= 1
      this.wake()
    }
  }

  /** Resolves once no reader is inside `receive` (cue handlers included). */
  async idle(): Promise<void> {
    while (this.readers > 0) await this.waitForAdvance('Replay readers did not finish')
  }

  /** Throws the first mismatch, or a list of frames the run never consumed. */
  assertDone(): void {
    if (this.failure) throw this.failure
    const rest = this.transcript.frames.slice(this.cursor)
    if (rest.length === 0) return
    throw new ReplayMismatchError(
      `${rest.length} transcript frame(s) were not consumed (${this.header.adapter}/${this.header.scenario}), ` +
        `starting at frame ${this.cursor + 1}:\n` +
        rest.map((frame) => `${frame.dir} ${JSON.stringify(frame.frame)}`).join('\n')
    )
  }

  /** The first replay failure, if any; providers may swallow the thrown error. */
  get error(): Error | undefined {
    return this.failure
  }

  private advance(): void {
    this.cursor += 1
    this.wake()
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  private waitForAdvance(stallMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiters.delete(done)
        try {
          this.fail(stallMessage)
        } catch (error) {
          reject(error)
        }
      }, this.stallMs)
      this.waiters.add(done)
    })
  }

  private fail(message: string): never {
    this.failure ??= new ReplayMismatchError(`${this.header.adapter}/${this.header.scenario}: ${message}`)
    this.wake()
    throw this.failure
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'undefined'
}

/** Line diff of two pretty-printed values: `-` transcript, `+` actual. */
export function lineDiff(expected: unknown, actual: unknown): string {
  const left = pretty(expected).split('\n')
  const right = pretty(actual).split('\n')
  const out = ['--- transcript', '+++ sent']
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) out.push(`  ${left[index]}`)
    else {
      if (left[index] !== undefined) out.push(`- ${left[index]}`)
      if (right[index] !== undefined) out.push(`+ ${right[index]}`)
    }
  }
  return out.join('\n')
}

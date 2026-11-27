import type { MmsProfileServices } from '../../MmsProfileServices'
import { NetError } from '../../../shared/net'
import type { SqliteNodePolicy } from '../../net/store/nodePolicy'
import { botsFeedSource, botStreamSource } from '../remote/BotStreamSources'
import { mmsJson } from '../remote/jsonOutput'
import { MmsListsSource, type ListsServices } from '../remote/MmsListsSource'
import { MmsRemoteBackend } from '../remote/MmsBackend'
import { MmsThreadSource, type SnapshotBoundary } from '../remote/MmsThreadSource'
import { parsePrivateKey, terminalParts, type PrivateSpec } from '../remote/privateStreams'
import type { ThreadSourceEvent } from '../remote/ThreadStreamAdapter'

/** Output a terminal record carries at most, so one record stays well inside a record's bound. */
const PTY_RECORD_CHARS = 16 * 1024

/**
 * Every open display stream listens to the same few services, one listener each: up to 64 streams for
 * phones and hubs and up to 96 private ones. The default of 10 would warn long before that, so the
 * services that streams listen to are given room for them all.
 */
export function raiseStreamListenerLimits(services: MmsProfileServices, count = 256): void {
  const emitters: Array<{ getMaxListeners(): number; setMaxListeners(count: number): unknown }> = [
    services.orchestrator,
    services.questions,
    services.threads,
    services.threadRuntimes,
    services.pullRequestWatch,
    services.ptyManager
  ]
  // The bot streams listen to the bots' events, a few listeners each.
  if (services.personalBots) emitters.push(services.personalBots.events)
  for (const emitter of emitters)
    if (emitter.getMaxListeners() < count) emitter.setMaxListeners(count)
  services.events.setMaxListeners(count)
}

/** Cuts output into pieces of at most `PTY_RECORD_CHARS`, never between the two halves of a character. */
function split(text: string): string[] {
  const pieces: string[] = []
  for (let at = 0; at < text.length || !pieces.length;) {
    let end = Math.min(text.length, at + PTY_RECORD_CHARS)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    pieces.push(text.slice(at, end))
    at = end
  }
  return pieces
}

/** Thread streams whose snapshot boundary is kept: far more than a computer has open at once. */
const BOUNDARIES_MAX = 1024

/**
 * Where the records of a computer's private streams come from. The key a stream is stored under
 * says which one it is; each kind is sourced from the profile's own services, never from the reader.
 */
export class PrivateSources {
  /**
   * One backend for every thread stream: the page `warm` reads off the event loop is kept there for the snapshot that
   * opens the stream, which is read through a source made for that call.
   */
  private readonly threads: MmsRemoteBackend
  /**
   * Where the last snapshot of each thread stream began, by stream key, shared by the sources made for that stream. A
   * stream whose entry was let go sends whole transcript syncs again, as before snapshots were capped.
   */
  private readonly boundaries = new Map<string, SnapshotBoundary>()
  constructor(
    private readonly services: MmsProfileServices,
    /** The device's permission limit is read each time a request is shown, so a change applies at once. */
    private readonly policy: Pick<SqliteNodePolicy, 'get'>
  ) {
    this.threads = new MmsRemoteBackend(services)
  }

  snapshot(key: string): unknown {
    return this.sourceFor(key).snapshot()
  }

  /**
   * Reads what the snapshot of a thread stream needs off the event loop (its newest page), so opening the stream does
   * not load the thread. Nothing for the other kinds, whose snapshots are small.
   */
  async warm(key: string): Promise<void> {
    const spec = parsePrivateKey(key)
    if (spec?.kind === 'thread') await this.threads.warm(spec.subject, { newestOnly: true })
  }

  onThread(
    key: string,
    listener: (event: ThreadSourceEvent) => void,
    onError?: (error: unknown) => void
  ): () => void {
    return this.sourceFor(key).watch(listener, onError)
  }

  private boundaryOf(key: string): SnapshotBoundary {
    let boundary = this.boundaries.get(key)
    if (boundary) {
      this.boundaries.delete(key)
    } else {
      boundary = {}
      for (const oldest of this.boundaries.keys()) {
        if (this.boundaries.size < BOUNDARIES_MAX) break
        this.boundaries.delete(oldest)
      }
    }
    this.boundaries.set(key, boundary)
    return boundary
  }

  private sourceFor(key: string): {
    snapshot(): unknown
    watch(
      listener: (event: ThreadSourceEvent) => void,
      onError?: (error: unknown) => void
    ): () => void
  } {
    const spec = parsePrivateKey(key)
    if (!spec) throw new NetError('bad_request')
    switch (spec.kind) {
      case 'thread': {
        const boundary = this.boundaryOf(key)
        const source = new MmsThreadSource(this.services, undefined, {
          private: { limit: () => this.policy.get(spec.reader).maxPermissionMode, reader: spec.reader, boundary },
          backend: this.threads
        })
        return {
          snapshot: () => source.snapshot(spec.subject),
          watch: (listener, onError) => source.onThread(spec.subject, listener, onError)
        }
      }
      case 'lists': {
        // The bots in them are the ones that computer reaches.
        const lists = new MmsListsSource(this.services as unknown as ListsServices, undefined, {
          private: true,
          reader: spec.reader
        })
        return {
          snapshot: () => lists.snapshot(),
          watch: (listener, onError) => lists.watch(() => listener({ snapshot: true }), onError)
        }
      }
      case 'channel':
        // Progress is added by the action that makes it (`ThreadStreamAdapter.pushChannel`).
        return {
          snapshot: () => ({ kind: 'mousse.channel', version: 1 }),
          watch: () => () => undefined
        }
      case 'terminal':
        return terminalSource(this.services, spec)
      case 'bots':
        return botsFeedSource(this.services, spec.reader)
      case 'bot':
        return botStreamSource(this.services, spec.reader, spec.subject)
    }
  }
}

/**
 * One terminal of a thread. A reader gets its scrollback when it attaches and then every chunk of
 * output as its own record, in order, never merged with another: a terminal's output is a stream of
 * increments, not a state that a newer message replaces. A chunk keeps the terminal's own sequence
 * number (`pty.outputSince` fills a gap), and a large one is split into pieces that share it.
 */
function terminalSource(services: MmsProfileServices, spec: PrivateSpec) {
  const { threadId, ptyId } = terminalParts(spec.subject)
  return {
    snapshot: (): unknown => {
      const found = services.ptyManager.lookup(ptyId)
      if (found.alive && found.threadId !== threadId) throw new NetError('forbidden')
      return mmsJson({
        kind: 'mousse.terminal',
        version: 1,
        threadId,
        ptyId,
        alive: found.alive,
        sequence: found.alive ? found.sequence : 0,
        scrollback: services.ptyManager.getScrollback(ptyId)
      })
    },
    watch: (
      listener: (event: ThreadSourceEvent) => void,
      onError?: (error: unknown) => void
    ): (() => void) => {
      const send = (type: 'pty.data' | 'pty.exit', data: unknown): void => {
        try {
          listener({ type, data } as ThreadSourceEvent)
        } catch (error) {
          if (onError) onError(error)
          else throw error
        }
      }
      const data = (payload: { ptyId: string; data: string; sequence: number }): void => {
        if (payload.ptyId !== ptyId) return
        const pieces = split(payload.data)
        pieces.forEach((piece, part) =>
          send('pty.data', {
            ptyId,
            sequence: payload.sequence,
            data: piece,
            ...(pieces.length > 1 ? { part, parts: pieces.length } : {})
          })
        )
      }
      const exit = (payload: {
        ptyId: string
        exitCode?: number
        signal?: string | null
      }): void => {
        if (payload.ptyId === ptyId)
          send('pty.exit', { ptyId, exitCode: payload.exitCode, signal: payload.signal ?? null })
      }
      services.ptyManager.on('data', data)
      services.ptyManager.on('exit', exit)
      return () => {
        services.ptyManager.off('data', data)
        services.ptyManager.off('exit', exit)
      }
    }
  }
}

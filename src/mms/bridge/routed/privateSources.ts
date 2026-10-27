import type { MmsProfileServices } from '../../MmsProfileServices'
import { NetError } from '../../../shared/net'
import type { SqliteNodePolicy } from '../../net/store/nodePolicy'
import { mmsJson } from '../remote/jsonOutput'
import { MmsListsSource, type ListsServices } from '../remote/MmsListsSource'
import { MmsThreadSource } from '../remote/MmsThreadSource'
import { parsePrivateKey, terminalParts, type PrivateSpec } from '../remote/privateStreams'
import type { ThreadSourceEvent } from '../remote/ThreadStreamAdapter'

/** Output a terminal record carries at most, so one record stays well inside a record's bound. */
const PTY_RECORD_CHARS = 16 * 1024

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

/**
 * Where the records of a computer's private streams come from. The key a stream is stored under
 * says which one it is; each kind is sourced from the profile's own services, never from the reader.
 */
export class PrivateSources {
  constructor(
    private readonly services: MmsProfileServices,
    /** The device's permission limit is read each time a request is shown, so a change applies at once. */
    private readonly policy: Pick<SqliteNodePolicy, 'get'>
  ) {}

  snapshot(key: string): unknown {
    return this.sourceFor(key).snapshot()
  }

  onThread(
    key: string,
    listener: (event: ThreadSourceEvent) => void,
    onError?: (error: unknown) => void
  ): () => void {
    return this.sourceFor(key).watch(listener, onError)
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
        const source = new MmsThreadSource(this.services, undefined, {
          private: { limit: () => this.policy.get(spec.reader).maxPermissionMode }
        })
        return {
          snapshot: () => source.snapshot(spec.subject),
          watch: (listener, onError) => source.onThread(spec.subject, listener, onError)
        }
      }
      case 'lists': {
        const lists = new MmsListsSource(this.services as unknown as ListsServices, undefined, {
          private: true
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

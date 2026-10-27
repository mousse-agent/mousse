/**
 * What this computer knows of a thread another computer runs, built from the private stream it
 * reads: the snapshot the stream starts with and every record and note after it. The router answers
 * `thread.snapshot` from it, so the transcript has one source of truth per attached thread, whatever
 * order a routed read and the stream's records arrive in.
 */

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The part of a thread's state the stream carries. Ids are the owner's own (qualified on the way out). */
export interface ThreadViewState {
  thread: Json
  messages: Json[]
  /** Where the older part of a long transcript begins (`thread.messages` pages it); absent when all is here. */
  earlier?: unknown
  queue: Json[]
  pendingQuestions: Json[]
  activeTurn: Json
  connectionFailed: boolean
  turnState?: unknown
}

export interface ViewChange {
  /** The pending requests that appeared and the ones that went, after a questions note. */
  questions?: { added: Json[]; removed: string[] }
}

const idOf = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.id === 'string' ? value.id : undefined

export class RemoteThreadView {
  private state?: ThreadViewState

  /** Whether the stream's snapshot has been installed. */
  get ready(): boolean {
    return this.state !== undefined
  }

  /** Installs the stream's snapshot, replacing everything. */
  install(snapshot: unknown): void {
    if (!isRecord(snapshot)) return
    const messages = Array.isArray(snapshot.messages) ? (snapshot.messages as Json[]) : []
    this.state = {
      thread: isRecord(snapshot.thread) ? snapshot.thread : {},
      messages: [...messages],
      ...(snapshot.earlier !== undefined ? { earlier: snapshot.earlier } : {}),
      queue: Array.isArray(snapshot.queue) ? (snapshot.queue as Json[]) : [],
      pendingQuestions: Array.isArray(snapshot.pendingQuestions)
        ? (snapshot.pendingQuestions as Json[])
        : [],
      activeTurn: isRecord(snapshot.activeTurn) ? snapshot.activeTurn : { active: false, running: false },
      connectionFailed: false
    }
  }

  /** The state, as the shape `thread.snapshot` has for the part the stream carries. */
  read(): ThreadViewState | undefined {
    return this.state
  }

  /** Applies one record or note of the stream; false when it is not about the transcript or state. */
  apply(type: string, data: unknown): ViewChange | undefined {
    const state = this.state
    if (!state || !isRecord(data)) return undefined
    switch (type) {
      case 'thread.message':
      case 'thread.message-updated': {
        const message = data.message
        const id = idOf(message)
        if (!isRecord(message)) return undefined
        const at = id === undefined ? -1 : state.messages.findIndex((row) => row.id === id)
        if (at >= 0) state.messages[at] = message
        else state.messages.push(message)
        return {}
      }
      case 'thread.messages': {
        if (!Array.isArray(data.messages)) return undefined
        if (data.replace === true) state.messages = [...(data.messages as Json[])]
        else
          for (const message of data.messages as Json[]) {
            const at = state.messages.findIndex((row) => row.id === message.id)
            if (at >= 0) state.messages[at] = message
            else state.messages.push(message)
          }
        return {}
      }
      case 'queue.updated':
        if (Array.isArray(data.items)) state.queue = data.items as Json[]
        return {}
      case 'turn.started':
        state.activeTurn = { active: true, running: true }
        state.connectionFailed = false
        return {}
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.aborted':
        state.activeTurn = { active: false, running: false }
        return {}
      case 'turn.state':
        state.turnState = data
        return {}
      case 'connection.failed':
        state.connectionFailed = true
        return {}
      case 'thread.metadata':
        if (isRecord(data.thread)) state.thread = data.thread
        return {}
      case 'questions.updated': {
        if (!Array.isArray(data.pending)) return undefined
        const next = data.pending as Json[]
        const before = new Set(state.pendingQuestions.map((row) => String(row.requestId)))
        const after = new Set(next.map((row) => String(row.requestId)))
        const change: ViewChange = {
          questions: {
            added: next.filter((row) => !before.has(String(row.requestId))),
            removed: [...before].filter((requestId) => !after.has(requestId))
          }
        }
        state.pendingQuestions = next
        return change
      }
      default:
        return undefined
    }
  }
}

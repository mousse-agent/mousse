// Mock helper — shadcn/helpers/ai-sdk inspired `createChat`
// Use for storybook, docs, Vitest without daemon: chat.get(0) + chat.transport()
// No ai peer dep; fully typed to Mousse parts.
import type { MousseUIMessage, ChatPart, TextPart, ReasoningPart, ToolPart } from '../types/ui'

type Writer = {
  text: (text: string, opts?: { id?: string; delayMs?: number; mode?: 'stream' | 'instant' }) => Writer
  reasoning: (text: string, opts?: { id?: string; delayMs?: number; mode?: 'stream' | 'instant' }) => Writer
  tool: (name: string, opts?: { toolCallId?: string; input?: unknown; output?: unknown; errorText?: string; title?: string }) => ToolHandle
  data: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => Writer
  file: (opts: { mediaType?: string; url?: string; filename?: string }) => Writer
  sourceUrl: (opts: { sourceId?: string; url?: string; title?: string }) => Writer
  stepStart: () => Writer
  custom: (kind?: string) => Writer
  sleep: (ms: number) => Writer
  error: (msg?: string) => Writer
}

type ToolHandle = { sleep: (ms: number) => ToolHandle; output: (v: unknown) => Writer; error: (msg?: string) => Writer; denied: () => Writer }

interface ChatScriptEntry { role: 'user' | 'assistant' | 'error'; message: MousseUIMessage; delayBeforeMs?: number; toolHandles?: unknown }

export class MousseChat {
  private entries: ChatScriptEntry[] = []
  private prefix = 'msg'
  private toolPrefix = 'call'
  private seq = 0

  user(text: string, opts?: { id?: string; metadata?: Record<string, unknown> }): this {
    const id = opts?.id ?? `${this.prefix}-${++this.seq}`
    this.entries.push({ role: 'user', message: { id, role: 'user', parts: [{ type: 'text', text } as TextPart], createdAt: new Date().toISOString(), metadata: opts?.metadata } })
    return this
  }
  assistant(input?: string | ChatPart[] | ((ctx: { writer: Writer }) => void), opts?: { id?: string }): this {
    if (typeof input === 'function') {
      const parts: ChatPart[] = []
      let sleepMs = 0
      const writer: Writer = {
        text: (t, _o) => { parts.push({ type: 'text', text: t } as TextPart); return writer },
        reasoning: (t) => { parts.push({ type: 'reasoning', text: t } as ReasoningPart); return writer },
        tool: (name, o) => {
          const tc: ToolPart = { type: 'tool', toolName: name, toolCallId: o?.toolCallId ?? `${this.toolPrefix}-${++this.seq}`, state: o?.output !== undefined ? 'output-available' : o?.errorText ? 'output-error' : 'input-available', input: o?.input, output: o?.output, title: o?.title ?? name }
          parts.push(tc)
          const handle: ToolHandle = { sleep: () => handle, output: (v) => { tc.output = v; tc.state = 'output-available'; return writer }, error: () => { tc.state = 'output-error'; return writer }, denied: () => { tc.state = 'output-denied'; return writer } }
          return handle
        },
        data: (p) => { parts.push({ type: p.type, id: p.id, data: p.data } as ChatPart); return writer },
        file: (o) => { parts.push({ type: 'file', mediaType: o.mediaType ?? 'text/plain', url: o.url ?? '', filename: o.filename } as ChatPart); return writer },
        sourceUrl: (o) => { parts.push({ type: 'source-url', sourceId: o.sourceId ?? 'src-1', url: o.url ?? '', title: o.title } as ChatPart); return writer },
        stepStart: () => { parts.push({ type: 'step-start' } as ChatPart); return writer },
        custom: (k) => { parts.push({ type: 'custom', kind: k ?? 'test.output' } as ChatPart); return writer },
        sleep: (ms) => { sleepMs = ms; return writer },
        error: (m) => { parts.push({ type: 'text', text: m ?? 'An error occurred.' } as ChatPart); return writer },
      }
      input({ writer })
      const id = opts?.id ?? `${this.prefix}-${++this.seq}`
      this.entries.push({ role: 'assistant', delayBeforeMs: sleepMs || undefined, message: { id, role: 'assistant', parts, createdAt: new Date().toISOString() } })
      return this
    }
    const id = opts?.id ?? `${this.prefix}-${++this.seq}`
    const parts: ChatPart[] = typeof input === 'string' ? [{ type: 'text', text: input } as TextPart] : Array.isArray(input) ? input as ChatPart[] : [{ type: 'text', text: 'Summarize the uploaded receipt.' } as TextPart]
    this.entries.push({ role: 'assistant', message: { id, role: 'assistant', parts, createdAt: new Date().toISOString() } })
    return this
  }
  error(msg?: string): this {
    const id = `${this.prefix}-${++this.seq}`
    this.entries.push({ role: 'error', message: { id, role: 'assistant', parts: [{ type: 'text', text: msg ?? 'An error occurred.' } as TextPart], createdAt: new Date().toISOString() } })
    return this
  }
  sleep(ms: number): this {
    if (this.entries.length) this.entries[this.entries.length - 1].delayBeforeMs = ms
    return this
  }
  get(count?: number): MousseUIMessage[] {
    const msgs = this.entries.filter(e => e.role !== 'error').map(e => ({ ...e.message, parts: [...e.message.parts] }))
    if (count === undefined) return msgs
    return msgs.slice(0, count)
  }
  next(transcript: MousseUIMessage[]): MousseUIMessage | null {
    const ids = new Set(transcript.map(m => m.id))
    // Find next user entry after transcript
    const all = this.entries.filter(e => e.role === 'user')
    for (const e of all) if (!ids.has(e.message.id)) return { ...e.message, parts: [...e.message.parts] }
    return null
  }
  transport(opts?: { delayMs?: number; fallback?: string | ChatPart[] | ((ctx: { writer: Writer; messages: MousseUIMessage[] }) => void) }): MockTransport {
    return new MockTransport(this.entries, opts)
  }
}

class MockTransport {
  constructor(private entries: ChatScriptEntry[], private opts?: { delayMs?: number; fallback?: unknown }) {}
  async sendMessages(_messages: MousseUIMessage[]): Promise<AsyncIterable<ChatPart[]>> {
    // Find next assistant entry matching transcript length
    const assistants = this.entries.filter(e => e.role === 'assistant')
    const msg = assistants[0] // simplified: stream first
    const delay = this.opts?.delayMs ?? 30
    async function* gen() {
      if (!msg) return
      if (msg.delayBeforeMs) await new Promise(r => setTimeout(r, msg.delayBeforeMs))
      for (const part of msg.message.parts) {
        if (delay) await new Promise(r => setTimeout(r, delay))
        yield [part]
      }
    }
    return gen()
  }
}

export function createChat(): MousseChat { return new MousseChat() }

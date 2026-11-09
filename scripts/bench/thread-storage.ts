/**
 * Measures thread storage on a large generated thread: time per save, time to open, memory and size on disk.
 *
 *   node --expose-gc <bundled script>                              # JSON files
 *   MOUSSE_SQLITE_THREAD_STORE=1 node --expose-gc <bundled script> # thread.db
 *
 * Bundle it first: npx esbuild scripts/bench/thread-storage.ts --bundle --platform=node --format=esm --packages=external
 * --outfile=<dir>/bench.mjs. Set MOUSSE_THREAD_DB_WORKER to out/cli/threadDbWorker.js to measure with the real worker.
 *
 * The thread has 5,000 messages, 300 tool results of 32 to 200 KB and 20 images. Nothing outside a temporary
 * home is touched.
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import type { ChatMessage } from '../../src/shared/types'

const MESSAGES = Number(process.env.BENCH_MESSAGES ?? 5000)
const TOOL_OUTPUTS = Number(process.env.BENCH_TOOL_OUTPUTS ?? 300)
const IMAGES = Number(process.env.BENCH_IMAGES ?? 20)

function words(bytes: number, seed: number): string {
  const vocab = ['thread', 'storage', 'sqlite', 'message', 'agent', 'tool', 'result', 'page', 'index', 'search', 'mousse', 'worker']
  let out = ''
  let i = seed
  while (out.length < bytes) out += vocab[(i++ * 7) % vocab.length] + (i % 13 === 0 ? '.\n' : ' ')
  return out.slice(0, bytes)
}

function generate(): ChatMessage[] {
  const messages: ChatMessage[] = []
  const toolEvery = Math.max(1, Math.floor(MESSAGES / TOOL_OUTPUTS))
  const imageEvery = Math.max(1, Math.floor(MESSAGES / Math.max(1, IMAGES)))
  let tools = 0
  let images = 0
  const start = Date.parse('2026-01-01T00:00:00Z')
  for (let i = 0; i < MESSAGES; i++) {
    const timestamp = new Date(start + i * 1000).toISOString()
    const id = `m-${i}-${randomBytes(4).toString('hex')}`
    if (i % toolEvery === 0 && tools < TOOL_OUTPUTS) {
      tools += 1
      const size = 32_000 + ((i * 7919) % 168_000)
      messages.push({
        id, role: 'assistant', content: '', timestamp, kind: 'tool',
        toolCall: { title: 'Run command', summary: 'npm test', details: [], response: words(size, i), status: 'done', toolName: 'bash', input: { command: 'npm test' } }
      } as unknown as ChatMessage)
    } else if (i % 2 === 0) {
      const message = { id, role: 'user', content: words(200 + (i % 1800), i), timestamp } as ChatMessage
      if (i % imageEvery === 0 && images < IMAGES) {
        images += 1
        message.images = [{ name: `shot-${i}.png`, mimeType: 'image/png', data: randomBytes(150_000).toString('base64') }]
      }
      messages.push(message)
    } else {
      messages.push({ id, role: 'assistant', content: words(500 + (i % 3000), i), timestamp } as ChatMessage)
    }
  }
  return messages
}

function folderBytes(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? folderBytes(path) : statSync(path).size
  }
  return total
}

function time<T>(fn: () => T): [T, number] {
  const started = process.hrtime.bigint()
  const value = fn()
  return [value, Number(process.hrtime.bigint() - started) / 1e6]
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = process.hrtime.bigint()
  const value = await fn()
  return [value, Number(process.hrtime.bigint() - started) / 1e6]
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

type MaybePaged = ThreadDataStore & {
  readMessagePage?: (id: string, page: { limit: number; maxBytes: number; images?: boolean }) => Promise<{ messages: ChatMessage[] } | undefined>
  closeThreadStorage?: () => void
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

interface WritePhase { threadId: string; firstSave: number; streaming: number[]; toolSaves: number[]; bytes: number }

/** Writes the thread and times saves; everything it held is out of scope once it returns. */
function writePhase(home: string): WritePhase {
  const store = new ThreadDataStore(new ProjectManager(home), home) as MaybePaged
  const thread = store.createThread('Bench', undefined, undefined, { started: true })
  const messages = generate()
  const [, firstSave] = time(() => store.mutateThreadData(thread.id, () => ({ messages })))
  // A streaming save: the last assistant message grows by one delta.
  const streaming: number[] = []
  for (let i = 0; i < 40; i++) {
    messages[messages.length - 1].content += ' more streamed text'
    streaming.push(time(() => store.mutateThreadData(thread.id, () => ({ messages })))[1])
  }
  // A tool result: one new message with a 64 KB output.
  const toolSaves: number[] = []
  for (let i = 0; i < 20; i++) {
    messages.push({
      id: `tool-${i}`, role: 'assistant', content: '', timestamp: new Date().toISOString(), kind: 'tool',
      toolCall: { title: 'Read file', summary: 'x', details: [], response: words(64_000, i), status: 'done', toolName: 'read', input: {} }
    } as unknown as ChatMessage)
    toolSaves.push(time(() => store.mutateThreadData(thread.id, () => ({ messages })))[1])
  }
  store.closeThreadStorage?.()
  return { threadId: thread.id, firstSave, streaming, toolSaves, bytes: folderBytes(join(home, 'thread-data', 'standalone')) }
}

async function main(): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bench-')))
  process.env.MOUSSE_HOME = home
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
  const gc = (globalThis as { gc?: () => void }).gc
  try {
    const written = writePhase(home)
    gc?.()
    gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    const reopened = new ThreadDataStore(new ProjectManager(home), home) as MaybePaged
    let openPage = 'n/a'
    let heapAfterPage = 'n/a'
    if (reopened.readMessagePage && process.env.MOUSSE_SQLITE_THREAD_STORE === '1') {
      // What opening a thread costs now: its newest 200 messages, read in the read worker.
      const [, ms] = await timeAsync(() => reopened.readMessagePage!(written.threadId, { limit: 200, maxBytes: 16 * 1024 * 1024, images: true }))
      openPage = `${ms.toFixed(1)} ms`
      gc?.()
      gc?.()
      heapAfterPage = mb(process.memoryUsage().heapUsed - heapBefore)
    }
    const [loaded, openAll] = await timeAsync(async () => {
      const warm = (reopened as { loadThreadDataAsync?: (id: string) => Promise<ReturnType<ThreadDataStore['loadThreadData']>> }).loadThreadDataAsync
      return warm ? warm.call(reopened, written.threadId) : reopened.loadThreadData(written.threadId)
    })
    gc?.()
    gc?.()
    const heapAfter = process.memoryUsage().heapUsed
    reopened.closeThreadStorage?.()
    console.log(JSON.stringify({
      store: process.env.MOUSSE_SQLITE_THREAD_STORE === '1' ? 'sqlite' : 'json',
      messages: loaded.messages.length,
      firstSaveMs: +written.firstSave.toFixed(1),
      streamingSaveMedianMs: +median(written.streaming).toFixed(2),
      streamingSaveP99Ms: +percentile(written.streaming, 0.99).toFixed(2),
      toolResultSaveMedianMs: +median(written.toolSaves).toFixed(2),
      toolResultSaveP99Ms: +percentile(written.toolSaves, 0.99).toFixed(2),
      openNewestPage: openPage,
      heapHeldAfterNewestPage: heapAfterPage,
      openWholeThreadMs: +openAll.toFixed(1),
      heapHeldAfterOpen: mb(heapAfter - heapBefore),
      sizeOnDisk: mb(written.bytes)
    }, null, 2))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

void main()

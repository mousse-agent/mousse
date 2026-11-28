import { url as inspectorUrl } from 'node:inspector'
import { Worker } from 'node:worker_threads'

/**
 * Names what holds the daemon's main thread when it stops answering. A window replaces a service that answers nothing
 * for a minute (`GuiMmsController.replaceUnresponsiveService`); until now `daemon.log` then showed only the next start,
 * never what the stuck one was doing.
 *
 * The main thread stamps the time into shared memory every `heartbeatMs`. A thread of its own reads the stamp; once it
 * is `thresholdMs` old, that thread opens an inspector session on the main thread, pauses it, reads its call stack and
 * resumes it at once, as a debugger's pause button would. It reads the stack again every `resampleMs` while the stall
 * lasts, up to `maxSamples` times, and writes a line when the main thread is back, so a stall shows how long it lasted
 * and where it was, also when the service is ended before it comes back.
 *
 * JavaScript running in a loop is paused at once; the first sample of a stall also turns the debugger on, which has the
 * main thread list every script it has loaded (about half a second in the service), and later samples of that stall
 * reuse it. A synchronous call into Node (a file read, `spawnSync`, a database query) is not interrupted: the pause
 * lands in the code it returns to, and the line says how long the pause waited (`pauseMs`). One still not back after
 * `resampleMs` is logged as such.
 *
 * Lines go straight to `daemon.log` (`[warn:stall]`), from this thread: the main thread's own writes are buffered and
 * would wait out the stall. They hold function names and script paths below the app's folder (`main/index.js:120:7`),
 * never values, arguments or the home folder. At most `maxPerHour` stalls are sampled an hour; the rest are counted.
 */

export interface DaemonStallWatchOptions {
  /** The file the lines are appended to: the daemon's `daemon.log`. */
  logPath: string
  /** A main thread held this long is a stall, and its stack is read then. */
  thresholdMs?: number
  /** While a stall lasts, its stack is read again this often. */
  resampleMs?: number
  /** Stacks read in one stall, at most. */
  maxSamples?: number
  /** How often the main thread stamps the time. */
  heartbeatMs?: number
  /** How often the watching thread reads the stamp. */
  pollMs?: number
  /** Frames kept from each stack, from the innermost. */
  maxFrames?: number
  /** Stalls sampled in any hour, at most. */
  maxPerHour?: number
}

export interface DaemonStallWatch {
  stop(): void
}

export const STALL_THRESHOLD_MS = 2_000
export const STALL_RESAMPLE_MS = 10_000
export const STALL_MAX_SAMPLES = 4
export const STALL_MAX_PER_HOUR = 30

/**
 * Plain JavaScript run with `eval`, so it needs no bundle entry of its own, like the exit watchdog's. It never waits on
 * the main thread except for the pause it asked for.
 */
const STALL_WATCH_SOURCE = String.raw`
const { workerData } = require('node:worker_threads')
const { Session } = require('node:inspector')
const { appendFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
const { beatBuffer, logPath, thresholdMs, resampleMs, maxSamples, pollMs, maxFrames, maxPerHour } = workerData
const beat = new BigInt64Array(beatBuffer)
const lastBeat = () => Number(Atomics.load(beat, 0))

try { mkdirSync(dirname(logPath), { recursive: true }) } catch {}
const write = (text) => {
  try { appendFileSync(logPath, new Date().toISOString() + ' [warn:stall] ' + text + '\n') } catch {}
}
const seconds = (ms) => (ms / 1000).toFixed(1) + ' s'

// A script's address below the app's folder, never the folder itself: it names the home folder.
const shortUrl = (url) => {
  if (!url) return '?'
  if (url.startsWith('node:')) return url
  const path = url.replace(/\\/g, '/')
  for (const marker of ['/out/', '/src/', '/node_modules/']) {
    const at = path.lastIndexOf(marker)
    if (at >= 0) return path.slice(at + 1)
  }
  return path.slice(path.lastIndexOf('/') + 1)
}

let stall = null
// The inspector session of the stall being sampled: opened at its first sample and closed when it ends, so only the
// first sample pays for turning the debugger on (the main thread lists every script it has loaded, about half a second
// in the service).
let open = null
// Set when this build cannot open one: stalls are still logged, without their stacks.
let broken = false
const sampledAt = []
let skipped = 0

const allowed = (now) => {
  while (sampledAt.length && now - sampledAt[0] > 3600000) sampledAt.shift()
  if (sampledAt.length >= maxPerHour) return false
  sampledAt.push(now)
  return true
}

const close = () => {
  if (!open) return
  const { session } = open
  open = null
  // Not from inside a callback of the session itself: a disconnect there can wait on the dispatch running it.
  setImmediate(() => {
    try { session.post('Debugger.disable', () => setImmediate(() => { try { session.disconnect() } catch {} })) } catch { try { session.disconnect() } catch {} }
  })
}

const fail = (error) => {
  broken = true
  write('stacks cannot be read: ' + ((error && (error.code || error.message)) || String(error)))
  if (open) {
    const { session } = open
    open = null
    try { session.disconnect() } catch {}
  }
  if (stall) stall.askedAt = null
}

const connect = (current) => {
  const session = new Session()
  try {
    session.connectToMainThread()
  } catch (error) {
    fail(error)
    return null
  }
  const scripts = new Map()
  const opened = { session, stall: current }
  session.on('Debugger.scriptParsed', (message) => { scripts.set(message.params.scriptId, message.params.url) })
  session.on('Debugger.paused', (message) => {
    // Resumed before anything else: the main thread waits on this thread now.
    session.post('Debugger.resume')
    const sampled = opened.stall
    // A pause this watch did not ask for (a debugger statement) is only let go.
    if (sampled.askedAt === null) return
    const landed = Date.now()
    const asked = sampled.askedAt
    const stack = message.params.callFrames.slice(0, maxFrames).map((frame) =>
      (frame.functionName || '(anonymous)') + ' ' + shortUrl(scripts.get(frame.location.scriptId) || frame.url) +
      ':' + (frame.location.lineNumber + 1) + ':' + (frame.location.columnNumber + 1))
    const fields = { sample: sampled.samples, pauseMs: landed - asked, stack }
    // The main thread stamped the time again before the pause landed: what it shows ran after the stall.
    if (lastBeat() > sampled.since) fields.afterStall = true
    if (sampled.unsampled) fields.unsampledStalls = sampled.unsampled
    write('main thread held ' + seconds(asked - sampled.since) + ' ' + JSON.stringify(fields))
    sampled.askedAt = null
    sampled.nextAt = landed + resampleMs
    if (stall !== sampled && open === opened) close()
  })
  session.post('Debugger.enable', (error) => { if (error && open === opened) fail(error) })
  return opened
}

const sample = (current) => {
  if (!open) open = connect(current)
  if (!open) return
  current.samples++
  current.askedAt = Date.now()
  // Right behind the enable, so the pause is set as soon as the main thread reads its messages.
  open.session.post('Debugger.pause', (error) => { if (error && open) fail(error) })
}

setInterval(() => {
  const now = Date.now()
  const since = lastBeat()
  const held = now - since
  if (stall && since > stall.since) {
    if (!stall.quiet) write('main thread was held ' + seconds(since - stall.since) + ' ' + JSON.stringify({ samples: stall.samples }))
    const ended = stall
    stall = null
    // One whose pause is still on its way is closed when it lands.
    if (open && open.stall === ended && ended.askedAt === null) close()
  }
  if (held < thresholdMs) return
  if (!stall) {
    if (!allowed(now)) {
      skipped++
      stall = { since, quiet: true }
      return
    }
    stall = { since, samples: 0, nextAt: now, askedAt: null, unsampled: skipped }
    skipped = 0
    if (broken) write('main thread held ' + seconds(held))
  }
  if (stall.quiet || broken) return
  if (stall.askedAt !== null) {
    if (!stall.noted && now - stall.askedAt >= resampleMs) {
      stall.noted = true
      write('main thread held ' + seconds(held) + '; it has run no JavaScript since its stack was asked for ' +
        seconds(now - stall.askedAt) + ' ago: a synchronous call (a file, a process, a database) holds it')
    }
    return
  }
  // A session still waiting on the last stall's pause is left to finish first.
  if (open && open.stall !== stall) return
  if (stall.samples < maxSamples && now >= stall.nextAt) sample(stall)
}, pollMs)
`

/**
 * Starts the watch for this process's main thread. Not while a debugger was attached at start: its breakpoints would
 * read as stalls, and the watch's resume would let them go.
 */
export function startDaemonStallWatch(opts: DaemonStallWatchOptions): DaemonStallWatch | null {
  if (inspectorUrl()) return null
  const beatBuffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT)
  const beat = new BigInt64Array(beatBuffer)
  const stamp = (): void => { Atomics.store(beat, 0, BigInt(Date.now())) }
  stamp()
  const heartbeat = setInterval(stamp, opts.heartbeatMs ?? 250)
  heartbeat.unref()
  const worker = new Worker(STALL_WATCH_SOURCE, {
    eval: true,
    workerData: {
      beatBuffer,
      logPath: opts.logPath,
      thresholdMs: opts.thresholdMs ?? STALL_THRESHOLD_MS,
      resampleMs: opts.resampleMs ?? STALL_RESAMPLE_MS,
      maxSamples: opts.maxSamples ?? STALL_MAX_SAMPLES,
      pollMs: opts.pollMs ?? 250,
      maxFrames: opts.maxFrames ?? 20,
      maxPerHour: opts.maxPerHour ?? STALL_MAX_PER_HOUR
    },
    resourceLimits: { maxOldGenerationSizeMb: 32 }
  })
  // Never keeps the process alive by itself.
  worker.unref()
  worker.on('error', () => undefined)
  return {
    stop: () => {
      clearInterval(heartbeat)
      void worker.terminate().catch(() => undefined)
    }
  }
}

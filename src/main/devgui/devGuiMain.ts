import { app, BrowserWindow, type WebContents } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'

/**
 * Dev-only self-inspection service for the Electron main process.
 *
 * Lets the Mousse orchestrator (via the daemon DevGuiBridge + poller) watch
 * and interact with its own dev window:
 * - screenshot: capturePage → PNG data URL + saved copy (Ctrl+R-free visual check)
 * - console: buffered renderer console messages (the DevTools console)
 * - reload: webContents.reload() — the programmatic Ctrl+R
 * - devtools: open / close / toggle the DevTools panel
 * - evaluate: run JS in the renderer — DOM inspection, selectors, state probes
 *
 * Never active in packaged builds.
 */

export function isDevGuiMainEnabled(): boolean {
  if (process.env.MOUSSE_DEV_GUI_TOOLS === '0') return false
  if (process.env.ELECTRON_RENDERER_URL) return true
  try {
    return !app.isPackaged
  } catch {
    return false
  }
}

export type DevGuiConsoleLevel = 'log' | 'warn' | 'error'

interface ConsoleEntry {
  seq: number
  ts: string
  level: DevGuiConsoleLevel
  message: string
  source: string
}

const MAX_CONSOLE_ENTRIES = 400
const MAX_EVALUATE_CHARS = 8_000
const MAX_EVALUATE_RESULT_CHARS = 32_000
/** Keep screenshots base64-comfortable inside the 4 MiB protocol frame budget. */
const SCREENSHOT_MAX_PNG_BYTES = 2_500_000
const SCREENSHOT_DOWNSCALE_WIDTH = 1280

const consoleBuffer: ConsoleEntry[] = []
let consoleSeq = 0

function levelFromCode(level: number): DevGuiConsoleLevel {
  if (level === 1) return 'warn'
  if (level >= 2) return 'error'
  return 'log'
}

/** Capture renderer console messages (DevTools console) into a ring buffer. */
export function attachDevGuiConsoleCapture(contents: WebContents): void {
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    consoleBuffer.push({
      seq: ++consoleSeq,
      ts: new Date().toISOString(),
      level: levelFromCode(level),
      message: String(message ?? ''),
      source: `${sourceId ?? '(unknown)'}:${line ?? 0}`
    })
    while (consoleBuffer.length > MAX_CONSOLE_ENTRIES) consoleBuffer.shift()
  })
}

export function readDevGuiConsole(limit = 80, level: string = 'all'): string {
  const normalized = Math.min(MAX_CONSOLE_ENTRIES, Math.max(1, Math.floor(limit) || 80))
  const entries =
    level === 'log' || level === 'warn' || level === 'error'
      ? consoleBuffer.filter((entry) => entry.level === level)
      : consoleBuffer
  return entries
    .slice(-normalized)
    .map((entry) => `[${entry.ts}] [${entry.level}] ${entry.message} (${entry.source})`)
    .join('\n')
}

export interface DevGuiActionResult {
  ok: boolean
  text?: string
  dataUrl?: string
  savedPath?: string
  width?: number
  height?: number
  error?: string
}

function resolveScreenshotDir(): string {
  const home = process.env.MOUSSE_HOME ?? join(homedir(), '.mousse')
  return join(home, 'devgui-screenshots')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function serializeEvaluateResult(value: unknown): string {
  if (value === undefined) return '(undefined)'
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value, null, 2)
    if (typeof json === 'string' && json.length > 0) {
      return json.length > MAX_EVALUATE_RESULT_CHARS
        ? `${json.slice(0, MAX_EVALUATE_RESULT_CHARS)}\n...[truncated]`
        : json
    }
  } catch {
    /* fall through to String() */
  }
  const text = String(value)
  return text.length > MAX_EVALUATE_RESULT_CHARS
    ? `${text.slice(0, MAX_EVALUATE_RESULT_CHARS)}\n...[truncated]`
    : text
}

/**
 * Execute one dev-GUI action against the live window. Callers must gate on
 * {@link isDevGuiMainEnabled} — evaluate in particular must never run in
 * packaged builds.
 */
export async function executeDevGuiAction(
  action: string,
  payload: Record<string, unknown>,
  getWindow: () => BrowserWindow | null
): Promise<DevGuiActionResult> {
  const win = getWindow()
  if (!win || win.isDestroyed()) {
    return { ok: false, error: 'Dev window is unavailable.' }
  }

  try {
    switch (action) {
      case 'screenshot': {
        const captured = await win.webContents.capturePage()
        // Protocol frames cap at 4 MiB — downscale HiDPI/4K captures so the
        // PNG reliably fits after base64 (+33%) inside the JSON envelope.
        let image = captured
        let size = image.getSize()
        let png = image.toPNG()
        let downscaled = false
        if (png.length > SCREENSHOT_MAX_PNG_BYTES && size.width > SCREENSHOT_DOWNSCALE_WIDTH) {
          image = captured.resize({ width: SCREENSHOT_DOWNSCALE_WIDTH })
          size = image.getSize()
          png = image.toPNG()
          downscaled = true
        }
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`
        const dir = resolveScreenshotDir()
        mkdirSync(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const savedPath = join(dir, `shot-${stamp}.png`)
        writeFileSync(savedPath, png)
        return {
          ok: true,
          text:
            `Screenshot captured (${size.width}x${size.height}, ${(png.length / 1024).toFixed(1)} KiB).` +
            (downscaled ? ' Downscaled to fit the dev transport.' : ''),
          dataUrl,
          savedPath,
          width: size.width,
          height: size.height
        }
      }
      case 'console': {
        const limit =
          typeof payload.limit === 'number' && Number.isFinite(payload.limit)
            ? Math.floor(payload.limit)
            : 80
        const level = typeof payload.level === 'string' ? payload.level : 'all'
        const text = readDevGuiConsole(limit, level)
        return { ok: true, text: text.trim() ? text : '(console buffer is empty)' }
      }
      case 'reload': {
        // Programmatic Ctrl+R / Cmd+R.
        win.webContents.reload()
        return { ok: true, text: 'Renderer reload triggered (Ctrl+R equivalent).' }
      }
      case 'devtools': {
        const mode = payload.action === 'open' || payload.action === 'close' ? payload.action : 'toggle'
        if (mode === 'open') {
          if (!win.webContents.isDevToolsOpened()) win.webContents.openDevTools({ mode: 'detach' })
          return { ok: true, text: 'DevTools opened (detached).' }
        }
        if (mode === 'close') {
          if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
          return { ok: true, text: 'DevTools closed.' }
        }
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
          return { ok: true, text: 'DevTools toggled closed.' }
        }
        win.webContents.openDevTools({ mode: 'detach' })
        return { ok: true, text: 'DevTools toggled open (detached).' }
      }
      case 'evaluate': {
        const expression = typeof payload.expression === 'string' ? payload.expression : ''
        if (!expression.trim()) {
          return { ok: false, error: 'expression is required.' }
        }
        if (expression.length > MAX_EVALUATE_CHARS) {
          return { ok: false, error: `expression exceeds ${MAX_EVALUATE_CHARS} characters.` }
        }
        const timeoutMs =
          typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs)
            ? Math.min(30_000, Math.max(1_000, Math.floor(payload.timeoutMs)))
            : 15_000
        const raw = await withTimeout(
          win.webContents.executeJavaScript(expression, true),
          timeoutMs,
          'Renderer evaluate'
        )
        const text = serializeEvaluateResult(raw)
        return { ok: true, text: text.trim() ? text : '(expression returned undefined)' }
      }
      default:
        return { ok: false, error: `Unknown dev GUI action: ${action}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

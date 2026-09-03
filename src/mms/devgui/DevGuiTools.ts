import { Type, type Tool } from '@earendil-works/pi-ai'
import { devGuiBridge, isDevGuiToolsEnabled } from './DevGuiBridge'

export { isDevGuiToolsEnabled }

/**
 * Dev-only orchestrator tools that let Mousse watch and interact with its own
 * Electron GUI while running under `npm run dev` (electron-vite):
 *
 * - screenshot: capture the live window (vision image + saved PNG path)
 * - console: read buffered renderer console messages (the DevTools console)
 * - reload: reload the renderer (same as Ctrl/Cmd+R)
 * - devtools: open / close / toggle the DevTools panel
 * - evaluate: run JS in the renderer — DOM inspection, selectors, state probes
 *
 * Transport goes through DevGuiBridge (GUI polls `gui.devtoolsPoll` and
 * answers `gui.devtoolsRespond`). Main-agent only, never subagents.
 */

export const DEV_GUI_TOOL_NAMES = [
  'mousse_gui_screenshot',
  'mousse_gui_console',
  'mousse_gui_reload',
  'mousse_gui_devtools',
  'mousse_gui_evaluate',
  'mousse_gui_status'
] as const

export type DevGuiToolName = (typeof DEV_GUI_TOOL_NAMES)[number]

export interface DevGuiToolResult {
  text: string
  isError: boolean
  /** Screenshot PNG bytes for vision-capable models. */
  image?: { data: string; mimeType: string }
}

const MAX_CONSOLE_LIMIT = 200
const MAX_EVALUATE_CHARS = 8_000
const MAX_EVALUATE_TIMEOUT_MS = 30_000

export class DevGuiTools {
  isDevGuiTool(name: string): boolean {
    return (DEV_GUI_TOOL_NAMES as readonly string[]).includes(name)
  }

  isEnabled(): boolean {
    return isDevGuiToolsEnabled()
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'mousse_gui_screenshot',
        description:
          'DEV ONLY: capture a screenshot of the live Mousse Electron window. ' +
          'Returns a vision image of the current UI plus the saved PNG path. ' +
          'Use it to verify UI changes visually after edits (layout, styling, new panels). ' +
          'Only available under `npm run dev`; fails otherwise.',
        parameters: Type.Object({})
      },
      {
        name: 'mousse_gui_console',
        description:
          'DEV ONLY: read the buffered Electron renderer console (the same messages ' +
          'shown in the DevTools console: log, warn, error, exceptions). ' +
          'Use it to diagnose renderer errors, failed requests, or React warnings ' +
          'after making UI changes. Only available under `npm run dev`.',
        parameters: Type.Object({
          limit: Type.Optional(
            Type.Number({ description: `Max entries to return (1-${MAX_CONSOLE_LIMIT}, default 80).` })
          ),
          level: Type.Optional(
            Type.String({ description: 'Filter: log, warn, error, or all (default all).' })
          )
        })
      },
      {
        name: 'mousse_gui_reload',
        description:
          'DEV ONLY: reload the Mousse renderer (same as pressing Ctrl+R / Cmd+R). ' +
          'Use it after changing renderer code when hot-reload did not pick it up, ' +
          'or to reset UI state before re-testing. Only available under `npm run dev`.',
        parameters: Type.Object({})
      },
      {
        name: 'mousse_gui_devtools',
        description:
          'DEV ONLY: open, close, or toggle the Electron DevTools panel for the ' +
          'Mousse window. Useful to pair with console/evaluate inspection. ' +
          'Only available under `npm run dev`.',
        parameters: Type.Object({
          action: Type.Optional(
            Type.String({ description: 'One of: open, close, toggle (default toggle).' })
          )
        })
      },
      {
        name: 'mousse_gui_evaluate',
        description:
          'DEV ONLY: run JavaScript in the Mousse renderer (the DevTools console ' +
          'context) and return the serialized result. Use it to inspect the DOM ' +
          'and app state, e.g. `document.title`, ' +
          '`document.querySelectorAll("[data-testid]").length`, ' +
          '`document.documentElement.outerHTML.slice(0, 4000)`, ' +
          '`localStorage.length`, or `location.href`. ' +
          'The expression must be a single JS expression (async allowed via ' +
          'top-level await semantics is NOT supported — return a Promise to await it). ' +
          'DOM reads only: do not navigate, reload, or mutate production data. ' +
          'If this fails with "no dev GUI attached", call mousse_gui_status. ' +
          'Only available under `npm run dev`.',
        parameters: Type.Object({
          expression: Type.String({ description: 'JS expression to evaluate in the renderer.' }),
          timeoutMs: Type.Optional(
            Type.Number({ description: 'Execution timeout ms (default 15000, max 30000).' })
          )
        })
      },
      {
        name: 'mousse_gui_status',
        description:
          'DEV ONLY: instant local diagnostic — reports whether a dev Electron ' +
          'window is attached to this daemon (last GUI poll, pending requests, ' +
          'daemon pid, MOUSSE_HOME). Never touches the window, never waits. ' +
          'Call this FIRST when any other mousse_gui_* tool reports no attached ' +
          'GUI or times out.',
        parameters: Type.Object({})
      }
    ]
  }

  async execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<DevGuiToolResult> {
    try {
      switch (name) {
        case 'mousse_gui_status':
          return this.status()
        case 'mousse_gui_screenshot':
          return await this.screenshot()
        case 'mousse_gui_console':
          return await this.console(args)
        case 'mousse_gui_reload':
          return await this.reload()
        case 'mousse_gui_devtools':
          return await this.devtools(args)
        case 'mousse_gui_evaluate':
          return await this.evaluate(args)
        default:
          return { text: `Unknown dev GUI tool: ${name}`, isError: true }
      }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  private status(): DevGuiToolResult {
    const s = devGuiBridge.getStatus()
    const lines = [
      `dev GUI tools enabled: ${s.enabled ? 'yes' : 'no'}`,
      `dev window attached: ${s.pollerAttached ? 'yes' : 'NO'}`,
      `last GUI poll: ${s.lastPollAgoMs === null ? 'never' : `${(s.lastPollAgoMs / 1000).toFixed(1)}s ago`}`,
      `pending dev GUI requests: ${s.pendingCount}`,
      `daemon pid: ${s.daemonPid}`,
      `MOUSSE_HOME: ${s.mousseHome}`
    ]
    if (!s.pollerAttached) {
      lines.push(
        'The Electron dev window is NOT serving tool requests right now. ' +
          'Verify: (1) the window was launched via `npm run dev` in this session ' +
          '(a window started before these tools were added has no poller — restart it); ' +
          '(2) it uses the same MOUSSE_HOME shown above; ' +
          '(3) the dev terminal shows `[devgui] poller started`. ' +
          'Until then, other mousse_gui_* tools fail fast instead of hanging.'
      )
    }
    return { text: lines.join('\n'), isError: false }
  }

  private async screenshot(): Promise<DevGuiToolResult> {    const res = await devGuiBridge.request('screenshot')
    if (!res.ok) return { text: res.error ?? 'Screenshot failed.', isError: true }
    const parts = [res.text ?? 'Screenshot captured.']
    if (res.savedPath) parts.push(`Saved: ${res.savedPath}`)
    if (res.dataUrl) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(res.dataUrl)
      if (match) {
        return {
          text: parts.join('\n'),
          isError: false,
          image: { mimeType: match[1], data: match[2] }
        }
      }
      parts.push('Note: screenshot data was not valid base64 and was dropped.')
    }
    return { text: parts.join('\n'), isError: false }
  }

  private async console(args: Record<string, unknown>): Promise<DevGuiToolResult> {
    const limit = this.clampLimit(args.limit)
    const level = this.normalizeLevel(args.level)
    const res = await devGuiBridge.request('console', { limit, level })
    if (!res.ok) return { text: res.error ?? 'Console read failed.', isError: true }
    return { text: res.text?.trim() ? res.text : '(console buffer is empty)', isError: false }
  }

  private async reload(): Promise<DevGuiToolResult> {
    const res = await devGuiBridge.request('reload')
    if (!res.ok) return { text: res.error ?? 'Reload failed.', isError: true }
    return { text: res.text ?? 'Renderer reload triggered (Ctrl+R equivalent).', isError: false }
  }

  private async devtools(args: Record<string, unknown>): Promise<DevGuiToolResult> {
    const raw = typeof args.action === 'string' ? args.action.toLowerCase() : 'toggle'
    const action = raw === 'open' || raw === 'close' ? raw : 'toggle'
    const res = await devGuiBridge.request('devtools', { action })
    if (!res.ok) return { text: res.error ?? 'DevTools toggle failed.', isError: true }
    return { text: res.text ?? `DevTools ${action} triggered.`, isError: false }
  }

  private async evaluate(args: Record<string, unknown>): Promise<DevGuiToolResult> {
    const expression = typeof args.expression === 'string' ? args.expression : ''
    if (!expression.trim()) {
      return { text: 'expression is required (a JS expression to run in the renderer).', isError: true }
    }
    if (expression.length > MAX_EVALUATE_CHARS) {
      return {
        text: `expression exceeds ${MAX_EVALUATE_CHARS} characters; narrow the DOM query instead.`,
        isError: true
      }
    }
    const timeoutMs = this.clampTimeout(args.timeoutMs)
    const res = await devGuiBridge.request('evaluate', { expression, timeoutMs }, Math.max(timeoutMs + 10_000, 30_000))
    if (!res.ok) return { text: res.error ?? 'Evaluate failed.', isError: true }
    return { text: res.text?.trim() ? res.text : '(expression returned undefined)', isError: false }
  }

  private clampLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 80
    return Math.min(MAX_CONSOLE_LIMIT, Math.max(1, Math.floor(value)))
  }

  private normalizeLevel(value: unknown): string {
    if (value === 'log' || value === 'warn' || value === 'error') return value
    return 'all'
  }

  private clampTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 15_000
    return Math.min(MAX_EVALUATE_TIMEOUT_MS, Math.max(1_000, Math.floor(value)))
  }
}

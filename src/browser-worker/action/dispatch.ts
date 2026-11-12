import type { BrowserAction, BrowserHumanInput } from '../../shared/browser/types'
import {
  BROWSER_PROBLEM_CODES,
  browserProblemMessage,
  classifyNavigationFailure,
  classifyOpenedPage,
  hostOf,
  retryAfterSeconds,
  type BrowserNavigation,
  type BrowserNavigationResponse,
  type BrowserPageSigns,
  type BrowserProblem
} from '../../shared/browser/navigation'
import type { CdpTransport } from '../cdp/transport'
import { BrowserWorkerError, fail } from '../errors'
import { browserNavigationUrl } from '../../shared/browser/validation'
import type { ActionableTarget } from './actionability'
import { readControlValue } from './actionability'

function mouseButton(button?: 'left' | 'right' | 'middle'): 'left' | 'right' | 'middle' {
  return button ?? 'left'
}

/** The `buttons` bit a pressed button sets, as in `MouseEvent.buttons`. */
const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const

/**
 * A click as a mouse makes one: the pointer arrives with no button held, the button goes down, then
 * up. A move that names a button reads as a drag that started before the press.
 */
async function mouseClick(
  cdp: CdpTransport,
  sessionId: string,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  clickCount: number,
  signal?: AbortSignal
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, { sessionId, signal })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTON_BITS[button], clickCount }, { sessionId, signal })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount }, { sessionId, signal })
}

async function focus(cdp: CdpTransport, sessionId: string, backendNodeId: number, signal?: AbortSignal): Promise<void> {
  await cdp.send('DOM.focus', { backendNodeId }, { sessionId, signal })
}

async function selectAll(cdp: CdpTransport, sessionId: string, signal?: AbortSignal): Promise<void> {
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, { sessionId, signal })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, { sessionId, signal })
}

export async function dispatchAction(
  cdp: CdpTransport,
  cdpSessionId: string,
  action: BrowserAction,
  target: ActionableTarget | { from: ActionableTarget; to: ActionableTarget } | undefined,
  signal?: AbortSignal
): Promise<void> {
  switch (action.type) {
    case 'navigate':
      await cdp.send('Page.navigate', { url: browserNavigationUrl(action.url) }, { sessionId: cdpSessionId, timeoutMs: 30_000, signal })
      return
    case 'reload':
      await cdp.send('Page.reload', {}, { sessionId: cdpSessionId, signal })
      return
    case 'back':
    case 'forward': {
      const history = await cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory', {}, { sessionId: cdpSessionId, signal })
      const next = action.type === 'back' ? history.currentIndex - 1 : history.currentIndex + 1
      const entry = history.entries[next]
      if (!entry) fail('not_actionable', `No ${action.type} history entry`)
      await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, { sessionId: cdpSessionId, signal })
      return
    }
    case 'click':
    case 'double-click':
    case 'hover': {
      if (!target || 'from' in target) fail('invalid_action', 'Pointer action requires a target')
      if (target.disabled) fail('not_actionable', 'Target is disabled')
      if (action.type === 'hover') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.point.x, y: target.point.y }, { sessionId: cdpSessionId, signal })
        return
      }
      await mouseClick(cdp, cdpSessionId, target.point.x, target.point.y, mouseButton(action.button), action.type === 'double-click' ? 2 : 1, signal)
      return
    }
    case 'fill':
    case 'type': {
      if (!target || 'from' in target) fail('invalid_action', 'Text action requires a target')
      if (target.disabled || target.readOnly) fail('not_actionable', 'Target is not editable')
      await focus(cdp, cdpSessionId, target.backendNodeId, signal)
      await mouseClick(cdp, cdpSessionId, target.point.x, target.point.y, 'left', 1, signal)
      if (action.type === 'fill') {
        await cdp.send('Runtime.callFunctionOn', {
          objectId: target.objectId,
          functionDeclaration: 'function() { if (this.select) this.select(); }'
        }, { sessionId: cdpSessionId, signal })
        await selectAll(cdp, cdpSessionId, signal)
      }
      if (action.text) await cdp.send('Input.insertText', { text: action.text }, { sessionId: cdpSessionId, signal })
      return
    }
    case 'key': {
      if (target && !('from' in target)) await focus(cdp, cdpSessionId, target.backendNodeId, signal)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, text: action.key.length === 1 ? action.key : undefined }, { sessionId: cdpSessionId, signal })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key }, { sessionId: cdpSessionId, signal })
      return
    }
    case 'select': {
      if (!target || 'from' in target) fail('invalid_action', 'Select requires a target')
      if (target.disabled) fail('not_actionable', 'Target is disabled')
      await cdp.send('Runtime.callFunctionOn', {
        objectId: target.objectId,
        functionDeclaration: `function(values) {
          if (!(this instanceof HTMLSelectElement)) throw new Error('not a select');
          const wanted = new Set(values);
          for (const option of this.options) option.selected = wanted.has(option.value) || wanted.has(option.text);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value: action.values }]
      }, { sessionId: cdpSessionId, signal })
      return
    }
    case 'check': {
      if (!target || 'from' in target) fail('invalid_action', 'Check requires a target')
      if (target.disabled) fail('not_actionable', 'Target is disabled')
      const current = await readControlValue(cdp, cdpSessionId, target.objectId, signal)
      if (!!current.checked !== action.checked) {
        await mouseClick(cdp, cdpSessionId, target.point.x, target.point.y, 'left', 1, signal)
      }
      return
    }
    case 'scroll': {
      const point = target && !('from' in target) ? target.point : undefined
      const x = point?.x ?? 10
      const y = point?.y ?? 10
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: action.deltaX, deltaY: action.deltaY }, { sessionId: cdpSessionId, signal })
      return
    }
    case 'drag': {
      if (!target || !('from' in target)) fail('invalid_action', 'Drag requires two targets')
      if (target.from.disabled || target.to.disabled) fail('not_actionable', 'Drag target is disabled')
      const from = target.from.point
      const to = target.to.point
      const steps = Math.min(40, Math.max(4, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 24)))
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 }, { sessionId: cdpSessionId, signal })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 }, { sessionId: cdpSessionId, signal })
      for (let index = 1; index <= steps; index += 1) {
        if (signal?.aborted) fail('cancelled', 'Drag cancelled')
        const t = index / steps
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: 'left', buttons: 1 }, { sessionId: cdpSessionId, signal })
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }, { sessionId: cdpSessionId, signal })
      return
    }
    case 'upload':
      if (!target || 'from' in target) fail('invalid_action', 'Upload requires a target')
      if (target.tag !== 'INPUT' || target.type !== 'file') fail('not_actionable', 'Upload target must be an input[type=file]')
      const resolved = action.resolvedArtifacts
      if (!resolved || resolved.length !== action.artifactIds.length) fail('artifact_denied', 'Upload requires an MMS-staged artifact grant')
      const inputState = await cdp.send<{ result: { value?: { accept?: string; multiple?: boolean } } }>('Runtime.callFunctionOn', {
        objectId: target.objectId,
        functionDeclaration: `function() {
          return { accept: String(this.accept || ''), multiple: !!this.multiple };
        }`,
        returnByValue: true
      }, { sessionId: cdpSessionId, signal })
      const accept = inputState.result?.value?.accept?.trim() ?? ''
      if (resolved.length > 1 && !inputState.result?.value?.multiple) fail('not_actionable', 'Upload target does not accept multiple files')
      if (accept) {
        const rules = accept.split(',').map((rule) => rule.trim().toLowerCase()).filter(Boolean)
        for (const item of resolved) {
          const name = item.displayName.toLowerCase()
          const mediaType = (item.mediaType ?? '').toLowerCase()
          const accepted = rules.some((rule) => rule === '*/*' || (rule.endsWith('/*') && mediaType.startsWith(rule.slice(0, -1))) || (rule.startsWith('.') && name.endsWith(rule)) || rule === mediaType)
          if (!accepted) fail('not_actionable', `Upload artifact ${item.displayName} does not match the input accept filter`)
        }
      }
      await cdp.send('DOM.setFileInputFiles', { files: resolved.map((item) => item.path), backendNodeId: target.backendNodeId }, { sessionId: cdpSessionId, signal })
      return
    case 'dialog':
      await cdp.send('Page.handleJavaScriptDialog', { accept: action.accept, ...(action.promptText === undefined ? {} : { promptText: action.promptText }) }, { sessionId: cdpSessionId, signal })
      return
    default:
      fail('unsupported', 'Unsupported action')
  }
}

/** Keys a person may press in a managed tab, with the codes Chromium needs to act on them. */
const HUMAN_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 }
}

/**
 * A person's pointer or keyboard input while they hold a managed tab (`BrowserHumanInput`), sent as
 * trusted input at viewport CSS pixels. Navigation is the session's: it waits for the page.
 */
export async function dispatchHumanInput(cdp: CdpTransport, cdpSessionId: string, input: Exclude<BrowserHumanInput, { kind: 'navigate' | 'back' | 'forward' | 'reload' }>, signal?: AbortSignal): Promise<void> {
  switch (input.kind) {
    case 'click':
      await mouseClick(cdp, cdpSessionId, input.x, input.y, 'left', 1, signal)
      return
    case 'scroll':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY }, { sessionId: cdpSessionId, signal })
      return
    case 'type':
      await cdp.send('Input.insertText', { text: input.text }, { sessionId: cdpSessionId, signal })
      return
    case 'key': {
      const known = HUMAN_KEYS[input.key]
      const text = known?.text ?? (input.key.length === 1 ? input.key : undefined)
      const codes = known ? { code: known.code, windowsVirtualKeyCode: known.keyCode, nativeVirtualKeyCode: known.keyCode } : {}
      await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: input.key, ...codes, ...(text ? { text } : {}) }, { sessionId: cdpSessionId, signal })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: input.key, ...codes }, { sessionId: cdpSessionId, signal })
      return
    }
  }
}

/**
 * How long this computer's recent navigations took to reach a ready document. The ceiling a
 * navigation call waits for its page scales with it: four times the median of the last 20 (the
 * slow ones of a slow computer or connection fit), never under 10 s nor over 45 s, and 15 s until
 * there are 5 to go by. Past the ceiling a page is reported as still loading, never as failed.
 */
export class NavigationPace {
  private readonly samples: number[] = []
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.samples.push(ms)
    if (this.samples.length > 20) this.samples.shift()
  }

  ceilingMs(): number {
    if (this.samples.length < 5) return 15_000
    const sorted = [...this.samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    return Math.min(45_000, Math.max(10_000, Math.round(median * 4)))
  }
}

/** The pace of this worker's navigations, across its sessions. */
export const navigationPace = new NavigationPace()

/** How long a ready page is given to finish loading before the call answers that it is still loading. */
export const LOAD_GRACE_MS = 1_500

export interface NavigationOptions {
  signal?: AbortSignal
  pace?: NavigationPace
  /** Overrides the pace's ceiling (tests). */
  ceilingMs?: number
  loadGraceMs?: number
  /** Reads what the opened page shows of a refusal or of needing a person (`readPageSigns`). */
  signs?: (frameId: string) => Promise<BrowserPageSigns | undefined>
  /** Answer at the commit (a person's own navigation: their view shows it loading from there). */
  untilCommit?: boolean
}

/**
 * Navigates a tab and answers once its page has committed and its document is ready: `ready` when
 * it also loaded within a moment, `loading` when it did not, or when the site had not answered (or
 * the document was not ready) by the ceiling. Neither is a failure: the page goes on loading. A
 * failure Chromium reports (`net::ERR_…`) fails with its class (`site_unreachable`,
 * `site_blocked`), its plain message and Chromium's code in the problem's details. Only this
 * navigation is waited for, never a replay from about:blank or a child frame.
 */
export async function navigateTab(cdp: CdpTransport, cdpSessionId: string, url: string, options: NavigationOptions = {}): Promise<BrowserNavigation> {
  const targetUrl = browserNavigationUrl(url)
  // The command answers with this navigation's own loader: only that one counts.
  return followNavigation(cdp, cdpSessionId, targetUrl, options, false, async () => {
    const result = await cdp.send<{ frameId: string; loaderId?: string; errorText?: string }>('Page.navigate', { url: targetUrl }, { sessionId: cdpSessionId, timeoutMs: 120_000, signal: options.signal })
    return result
  })
}

/** Back, forward or reload in a tab, followed like `navigateTab` (`url` is where it was). */
export async function navigateHistory(cdp: CdpTransport, cdpSessionId: string, kind: 'back' | 'forward' | 'reload', url: string, options: NavigationOptions = {}): Promise<BrowserNavigation> {
  // No answer names the loader: the next commit of the tab's main frame is this one.
  return followNavigation(cdp, cdpSessionId, url, options, true, async () => {
    await dispatchAction(cdp, cdpSessionId, { type: kind }, undefined, options.signal)
    return undefined
  })
}

interface StartedNavigation { frameId: string; loaderId?: string; errorText?: string }

/** Sessions whose Network domain a navigation turned on, and how many navigations use it. */
const networkUsers = new WeakMap<CdpTransport, Map<string, number>>()

/**
 * The main document's answers while a navigation runs (its HTTP status and `Retry-After`, which an
 * error page with an empty body only shows here). The Network domain is on only for that time.
 */
async function watchResponses(cdp: CdpTransport, cdpSessionId: string, mainFrameId: () => string | undefined): Promise<{ byLoader: Map<string, BrowserNavigationResponse>; stop(): void }> {
  const byLoader = new Map<string, BrowserNavigationResponse>()
  const onResponse = (params: unknown, sessionId?: string) => {
    if (sessionId !== cdpSessionId) return
    const event = params as { type?: string; frameId?: string; loaderId?: string; response?: { status?: number; headers?: Record<string, string> } }
    const main = mainFrameId()
    if (event.type !== 'Document' || !event.loaderId || typeof event.response?.status !== 'number' || (main && event.frameId !== main)) return
    const headers = event.response.headers ?? {}
    const wait = retryAfterSeconds(Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1])
    byLoader.set(event.loaderId, { status: event.response.status, ...(wait !== undefined ? { retryAfterSeconds: wait } : {}) })
  }
  const users = networkUsers.get(cdp) ?? new Map<string, number>()
  networkUsers.set(cdp, users)
  const count = users.get(cdpSessionId) ?? 0
  users.set(cdpSessionId, count + 1)
  cdp.on('Network.responseReceived', onResponse)
  if (!count) await cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, { sessionId: cdpSessionId, timeoutMs: 5_000 }).catch(() => undefined)
  return {
    byLoader,
    stop: () => {
      cdp.off('Network.responseReceived', onResponse)
      const left = (users.get(cdpSessionId) ?? 1) - 1
      if (left > 0) {
        users.set(cdpSessionId, left)
        return
      }
      users.delete(cdpSessionId)
      void cdp.send('Network.disable', {}, { sessionId: cdpSessionId, timeoutMs: 5_000 }).catch(() => undefined)
    }
  }
}

/** The tab's main frame: its id, and the address it shows now. */
async function mainFrame(cdp: CdpTransport, cdpSessionId: string): Promise<{ id?: string; url?: string }> {
  const tree = await cdp.send<{ frameTree?: { frame?: { id?: string; url?: string; urlFragment?: string } } }>('Page.getFrameTree', {}, { sessionId: cdpSessionId, timeoutMs: 5_000 }).catch(() => undefined)
  const frame = tree?.frameTree?.frame
  return { ...(frame?.id ? { id: frame.id } : {}), ...(frame?.url ? { url: frame.url + (frame.urlFragment ?? '') } : {}) }
}

/** How long a navigation Chromium dropped (`net::ERR_ABORTED`) waits to hear whether it became a download. */
const DOWNLOAD_WAIT_MS = 600

async function followNavigation(cdp: CdpTransport, cdpSessionId: string, url: string, options: NavigationOptions, commitByEvent: boolean, start: () => Promise<StartedNavigation | undefined>): Promise<BrowserNavigation> {
  const pace = options.pace ?? navigationPace
  const ceilingMs = options.ceilingMs ?? pace.ceilingMs()
  const graceMs = options.loadGraceMs ?? LOAD_GRACE_MS
  const startedAt = Date.now()
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: cdpSessionId, signal: options.signal })
  // Only the main frame's own events count, however many frames the page has.
  let mainFrameId = (await mainFrame(cdp, cdpSessionId)).id
  const responses = await watchResponses(cdp, cdpSessionId, () => mainFrameId)
  let download: string | undefined
  let onDownload: (() => void) | undefined
  const onPageDownload = (params: unknown, sessionId?: string) => {
    const event = params as { frameId?: string; suggestedFilename?: string }
    if (sessionId !== undefined && sessionId !== cdpSessionId) return
    if (sessionId === undefined && (!mainFrameId || event.frameId !== mainFrameId)) return
    download = event.suggestedFilename || 'download'
    onDownload?.()
  }
  cdp.on('Page.downloadWillBegin', onPageDownload)
  cdp.on('Browser.downloadWillBegin', onPageDownload)
  const outcome = await new Promise<BrowserNavigation & { frameId?: string; loaderId?: string }>((resolve, reject) => {
    /** The main frame's lifecycle events seen, by loader and name: one may come before the command's answer. */
    const seen = new Set<string>()
    let committed: { frameId: string; loaderId?: string; url: string } | undefined
    let ready = false
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const host = hostOf(url)
    const finish = (value?: BrowserNavigation & { frameId?: string; loaderId?: string }, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(ceiling)
      if (grace) clearTimeout(grace)
      cdp.off('Page.lifecycleEvent', onLifecycle)
      cdp.off('Page.frameNavigated', onNavigated)
      cdp.off('Page.navigatedWithinDocument', onWithinDocument)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value!)
    }
    /** Chromium dropped it: a download started, or another navigation replaced it. Either way, where the tab is. */
    const dropped = async () => {
      if (!download) {
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, DOWNLOAD_WAIT_MS)
          onDownload = () => { clearTimeout(timer); resolveWait() }
        })
      }
      const where = (await mainFrame(cdp, cdpSessionId)).url ?? url
      if (download) return finish({ url: where, state: 'ready', download: { name: download } })
      const state = await documentReadyState(cdp, cdpSessionId, mainFrameId).catch(() => undefined)
      finish({ url: where, state: state === 'complete' ? 'ready' : 'loading', replaced: { asked: url } })
    }
    const failure = async (errorText: string, loaderId?: string) => {
      const answer = () => loaderId ? responses.byLoader.get(loaderId) : [...responses.byLoader.values()].at(-1)
      // The site answered an error status with no page: its answer (the status) may reach us just after Chromium's.
      for (let waited = 0; errorText.trim() === 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' && !answer() && waited < 500; waited += 25) await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      if (settled) return
      const failed = classifyNavigationFailure(errorText, answer())
      if (failed.kind === 'aborted') return void dropped()
      // An error status with an empty body: the tab shows Chromium's page for it, and the note says what the site answered.
      if (failed.kind === 'status') return finish({ url, state: 'ready', notes: [failed.note] })
      const problem: BrowserProblem = { ...failed.problem, ...(host ? { host } : {}) }
      finish(undefined, new BrowserWorkerError(BROWSER_PROBLEM_CODES[problem.kind], browserProblemMessage(problem), problem))
    }
    const has = (name: string) => committed?.loaderId !== undefined && seen.has(`${committed.frameId}:${committed.loaderId}:${name}`)
    const done = (state: BrowserNavigation['state']) => finish({ url: committed!.url, state, frameId: committed!.frameId, ...(committed!.loaderId ? { loaderId: committed!.loaderId } : {}) })
    const advance = () => {
      if (settled || !committed) return
      if (!committed.loaderId) return done('ready')
      if (options.untilCommit) return finish({ url: committed.url, state: has('load') ? 'ready' : 'loading' })
      if (has('load')) {
        if (!ready) pace.record(Date.now() - startedAt)
        return done('ready')
      }
      if (!ready && has('DOMContentLoaded')) {
        ready = true
        pace.record(Date.now() - startedAt)
        // A moment for it to finish loading; past that it is still loading, and the call answers.
        grace = setTimeout(() => done('loading'), graceMs)
      }
    }
    const onLifecycle = (params: unknown, sessionId?: string) => {
      if (sessionId !== cdpSessionId) return
      const event = params as { name?: string; frameId?: string; loaderId?: string }
      if (!event.frameId || !event.loaderId || !event.name) return
      // The main frame's own events are always kept; a page's many frames never crowd them out.
      if (mainFrameId ? event.frameId !== mainFrameId : seen.size >= 512) return
      seen.add(`${event.frameId}:${event.loaderId}:${event.name}`)
      advance()
    }
    const onNavigated = (params: unknown, sessionId?: string) => {
      if (!commitByEvent || sessionId !== cdpSessionId || committed) return
      const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string; unreachableUrl?: string } })?.frame
      if (!frame?.id || frame.parentId) return
      mainFrameId ??= frame.id
      // Chromium's error page: the page the history step went to could not be loaded (or the site answered an error with no page).
      if (frame.unreachableUrl) {
        committed = { frameId: frame.id, url: frame.unreachableUrl }
        void (async () => {
          // The site's answer, when it gave one, may come a moment after the commit of Chromium's page.
          const answered = () => frame.loaderId ? responses.byLoader.get(frame.loaderId) : undefined
          for (let waited = 0; !answered() && waited < 500 && !settled; waited += 25) await new Promise((resolveWait) => setTimeout(resolveWait, 25))
          await failure((answered()?.status ?? 0) >= 400 ? 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' : 'net::ERR_FAILED', frame.loaderId)
        })()
        return
      }
      committed = { frameId: frame.id, loaderId: frame.loaderId, url: frame.url ?? url }
      advance()
    }
    const onWithinDocument = (params: unknown, sessionId?: string) => {
      if (!commitByEvent || sessionId !== cdpSessionId || committed) return
      const event = params as { frameId?: string; url?: string }
      if (!event.frameId) return
      committed = { frameId: event.frameId, url: event.url ?? url }
      advance()
    }
    const onAbort = () => finish(undefined, new BrowserWorkerError('cancelled', 'Navigation cancelled'))
    // The site has not answered, or the document is not ready, by the ceiling: it is still loading.
    const ceiling = setTimeout(() => finish({ url: committed?.url ?? url, state: 'loading', ...(committed ? { frameId: committed.frameId } : {}) }), ceilingMs)
    cdp.on('Page.lifecycleEvent', onLifecycle)
    cdp.on('Page.frameNavigated', onNavigated)
    cdp.on('Page.navigatedWithinDocument', onWithinDocument)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) { onAbort(); return }
    void start().then((result) => {
      if (settled || !result) return
      mainFrameId ??= result.frameId
      if (result.errorText) return failure(result.errorText, result.loaderId)
      // The command answers at the commit: same-document navigation has no new loader.
      committed = { frameId: result.frameId, url, ...(result.loaderId ? { loaderId: result.loaderId } : {}) }
      advance()
    }, (error) => {
      // A command that timed out on its own is a site that has not answered: still loading.
      if (error instanceof BrowserWorkerError) return finish(undefined, error)
      if (/timed out|timeout/i.test(String((error as Error)?.message ?? error))) return finish({ url, state: 'loading' })
      finish(undefined, error)
    })
  }).finally(() => {
    responses.stop()
    cdp.off('Page.downloadWillBegin', onPageDownload)
    cdp.off('Browser.downloadWillBegin', onPageDownload)
  })
  const { frameId, loaderId, ...navigation } = outcome
  // A page that opened is a failure only when it is nothing but a human check or a consent wall, or
  // the site refused it; what else it shows comes as notes the agent may deal with.
  if (frameId && options.signs) {
    const signs = await options.signs(frameId).catch(() => undefined)
    const response = loaderId ? responses.byLoader.get(loaderId) : undefined
    const opened = signs || response ? classifyOpenedPage({ ...signs, url: signs?.url ?? navigation.url }, response) : undefined
    // The page is there (a person may get past it in this tab): the navigation failed, the tab stays.
    if (opened?.problem) return { url: navigation.url, state: 'failed', problem: opened.problem }
    if (opened?.notes.length) return { ...navigation, notes: [...(navigation.notes ?? []), ...opened.notes] }
  }
  return navigation
}

/** `document.readyState` of the tab's main frame, read where the page's scripts can't change it. */
async function documentReadyState(cdp: CdpTransport, cdpSessionId: string, frameId: string | undefined): Promise<string | undefined> {
  if (!frameId) return undefined
  const world = await cdp.send<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId, worldName: 'mousse-page-signs' }, { sessionId: cdpSessionId, timeoutMs: 2_000 })
  if (!world.executionContextId) return undefined
  const read = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { contextId: world.executionContextId, returnByValue: true, expression: 'document.readyState' }, { sessionId: cdpSessionId, timeoutMs: 2_000 })
  return read.result?.value
}

/**
 * What an opened page shows, read in a world of its own (the page's scripts can't see it or change
 * what it reads). Only what is visible counts: a box of some size, shown, not transparent, in the
 * viewport. A human check or a consent dialog is the whole page when it covers most of the viewport
 * and the page behind can't be reached through it (the points sampled across the viewport all land
 * in it), or, for a check, when the page around it is almost empty (little text, hardly a control).
 * Markers alone (a class, a title) decide nothing.
 */
export async function readPageSigns(cdp: CdpTransport, cdpSessionId: string, frameId: string): Promise<BrowserPageSigns | undefined> {
  const world = await cdp.send<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId, worldName: 'mousse-page-signs' }, { sessionId: cdpSessionId, timeoutMs: 2_000 })
  if (!world.executionContextId) return undefined
  const read = await cdp.send<{ result?: { value?: BrowserPageSigns } }>('Runtime.evaluate', {
    contextId: world.executionContextId,
    returnByValue: true,
    expression: PAGE_SIGNS_SCRIPT
  }, { sessionId: cdpSessionId, timeoutMs: 2_000 })
  return read.result?.value
}

const PAGE_SIGNS_SCRIPT = `(() => {
  const vw = innerWidth || 1, vh = innerHeight || 1
  const nav = performance.getEntriesByType('navigation')[0]
  const status = nav && typeof nav.responseStatus === 'number' ? nav.responseStatus : 0
  const box = (el) => el.getBoundingClientRect()
  /** Seen: shown, not transparent, at least min wide and high, and in the viewport. */
  const seen = (el, minW, minH) => {
    if (!el || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return false
    const r = box(el)
    return r.width >= minW && r.height >= minH && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh
  }
  const share = (el) => {
    const r = box(el)
    const w = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left)), h = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top))
    return (w * h) / (vw * vh)
  }
  const top = (node) => !node || node === document.body || node === document.documentElement
  /** A fixed or absolute layer over most of the viewport that holds almost nothing but \`el\` (a backdrop, an overlay). */
  const backdropOf = (hit, el) => {
    for (let node = hit; !top(node); node = node.parentElement) {
      const position = getComputedStyle(node).position
      if ((position !== 'fixed' && position !== 'absolute') || share(node) < 0.6) continue
      // It goes with el: holds it, or shares an ancestor with it below the page itself.
      let related = node.contains(el)
      for (let up = node.parentElement; !related && !top(up); up = up.parentElement) related = up.contains(el)
      const own = (node.innerText || '').length - (node.contains(el) ? (el.innerText || '').length : 0)
      return related && own < 200 ? node : undefined
    }
    return undefined
  }
  /** Every point sampled across the viewport lands in it, or in its backdrop: the page behind can't be reached. */
  const covers = (el) => [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]].every(([x, y]) => {
    const hit = document.elementFromPoint(vw * x, vh * y)
    return !!hit && (el.contains(hit) || !!backdropOf(hit, el))
  })
  const CHECK_FRAMES = /challenges\\.cloudflare\\.com|google\\.com\\/recaptcha|recaptcha\\.net|hcaptcha\\.com|arkoselabs\\.com/i
  const checkFrames = [...document.querySelectorAll('iframe')].filter((frame) => CHECK_FRAMES.test(frame.src || '') && !/[?&]size=invisible/i.test(frame.src || '') && !frame.closest('.grecaptcha-badge'))
  const checkBoxes = [...document.querySelectorAll('#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, .cf-turnstile, .g-recaptcha, .h-captcha')]
    .filter((el) => !el.closest('.grecaptcha-badge'))
  const checks = [...checkFrames, ...checkBoxes].filter((el) => seen(el, 100, 40))
  let humanCheck
  if (checks.length) {
    const inside = (node) => checks.some((check) => check.contains(node) || node.contains(check))
    const controls = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea')].filter((el) => !inside(el) && seen(el, 4, 4)).length
    const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().length
    humanCheck = checks.some(covers) || (text < 600 && controls < 3) ? 'page' : 'part'
  }
  const consentBoxes = [...document.querySelectorAll('#onetrust-banner-sdk, #onetrust-consent-sdk [role=dialog], #onetrust-pc-sdk, #didomi-popup, .didomi-popup-container, #didomi-notice, #qc-cmp2-container, #qc-cmp2-ui, iframe[id^="sp_message_iframe"], #CybotCookiebotDialog, #usercentrics-root, [aria-modal=true][role=dialog], [role=dialog][aria-label*=cookie i], [role=dialog][aria-label*=consent i]')]
    .filter((el) => seen(el, 40, 20) && (el.matches('[aria-modal=true][role=dialog]') ? /cookie|consent|privacy/i.test(el.innerText || el.getAttribute('aria-label') || '') : true))
  let consent
  if (consentBoxes.length) consent = consentBoxes.some(covers) ? 'wall' : 'banner'
  else if (/^consent\\./i.test(location.hostname) && document.querySelector('form')) consent = 'wall'
  const signInForm = [...document.querySelectorAll('input[type=password]')].some((el) => seen(el, 20, 8))
  return { status, title: document.title, url: location.href, ...(humanCheck ? { humanCheck } : {}), ...(consent ? { consent } : {}), ...(signInForm ? { signInForm } : {}) }
})()`

export async function waitForLoad(cdp: CdpTransport, cdpSessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: cdpSessionId })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.min(timeoutMs, 8_000))
    const onEvent = (params: unknown, sessionId?: string) => {
      if (sessionId && sessionId !== cdpSessionId) return
      const name = (params as { name?: string } | undefined)?.name
      if (name === 'DOMContentLoaded' || name === 'load' || name === 'networkIdle') {
        cleanup()
        resolve()
      }
    }
    const onAbort = () => {
      cleanup()
      reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
    }
    const cleanup = () => {
      clearTimeout(timer)
      cdp.off('Page.lifecycleEvent', onEvent)
      signal?.removeEventListener('abort', onAbort)
    }
    cdp.on('Page.lifecycleEvent', onEvent)
    if (signal) {
      if (signal.aborted) {
        cleanup()
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

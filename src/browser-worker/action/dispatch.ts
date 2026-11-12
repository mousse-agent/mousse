import type { BrowserAction, BrowserHumanInput } from '../../shared/browser/types'
import {
  BROWSER_PROBLEM_CODES,
  browserProblemMessage,
  classifyNavigationError,
  classifyOpenedPage,
  hostOf,
  type BrowserNavigation,
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

async function followNavigation(cdp: CdpTransport, cdpSessionId: string, url: string, options: NavigationOptions, commitByEvent: boolean, start: () => Promise<StartedNavigation | undefined>): Promise<BrowserNavigation> {
  const pace = options.pace ?? navigationPace
  const ceilingMs = options.ceilingMs ?? pace.ceilingMs()
  const graceMs = options.loadGraceMs ?? LOAD_GRACE_MS
  const startedAt = Date.now()
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: cdpSessionId, signal: options.signal })
  const outcome = await new Promise<BrowserNavigation & { frameId?: string }>((resolve, reject) => {
    /** Lifecycle events seen, by frame, loader and name: one may come before the command's answer. */
    const seen = new Set<string>()
    let committed: { frameId: string; loaderId?: string; url: string } | undefined
    let ready = false
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const host = hostOf(url)
    const finish = (value?: BrowserNavigation & { frameId?: string }, error?: unknown) => {
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
    const failure = (errorText: string) => {
      const kind = classifyNavigationError(errorText)
      // A download, or a newer navigation: nothing failed.
      if (!kind) return finish({ url, state: 'ready' })
      const problem: BrowserProblem = { kind, code: errorText, ...(host ? { host } : {}) }
      finish(undefined, new BrowserWorkerError(BROWSER_PROBLEM_CODES[kind], browserProblemMessage(problem), problem))
    }
    const has = (name: string) => committed?.loaderId !== undefined && seen.has(`${committed.frameId}:${committed.loaderId}:${name}`)
    const advance = () => {
      if (settled || !committed) return
      if (!committed.loaderId) return finish({ url: committed.url, state: 'ready', frameId: committed.frameId })
      if (options.untilCommit) return finish({ url: committed.url, state: has('load') ? 'ready' : 'loading' })
      if (has('load')) {
        if (!ready) pace.record(Date.now() - startedAt)
        return finish({ url: committed.url, state: 'ready', frameId: committed.frameId })
      }
      if (!ready && has('DOMContentLoaded')) {
        ready = true
        pace.record(Date.now() - startedAt)
        // A moment for it to finish loading; past that it is still loading, and the call answers.
        grace = setTimeout(() => finish({ url: committed!.url, state: 'loading', frameId: committed!.frameId }), graceMs)
      }
    }
    const onLifecycle = (params: unknown, sessionId?: string) => {
      if (sessionId !== cdpSessionId) return
      const event = params as { name?: string; frameId?: string; loaderId?: string }
      if (!event.frameId || !event.loaderId || !event.name) return
      if (seen.size < 512) seen.add(`${event.frameId}:${event.loaderId}:${event.name}`)
      advance()
    }
    const onNavigated = (params: unknown, sessionId?: string) => {
      if (!commitByEvent || sessionId !== cdpSessionId || committed) return
      const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string; unreachableUrl?: string } })?.frame
      if (!frame?.id || frame.parentId) return
      // Chromium's error page: the page the history step went to could not be loaded.
      if (frame.unreachableUrl) return failure('net::ERR_FAILED')
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
      if (result.errorText) return failure(result.errorText)
      // The command answers at the commit: same-document navigation has no new loader.
      committed = { frameId: result.frameId, url, ...(result.loaderId ? { loaderId: result.loaderId } : {}) }
      advance()
    }, (error) => {
      // A command that timed out on its own is a site that has not answered: still loading.
      if (error instanceof BrowserWorkerError) return finish(undefined, error)
      if (/timed out|timeout/i.test(String((error as Error)?.message ?? error))) return finish({ url, state: 'loading' })
      finish(undefined, error)
    })
  })
  const { frameId, ...navigation } = outcome
  // A page that opened may still need a person (a sign-in, a human check) or refuse this browser: a hint, not a failure.
  if (frameId && options.signs) {
    const signs = await options.signs(frameId).catch(() => undefined)
    const problem = signs ? classifyOpenedPage({ ...signs, url: signs.url ?? navigation.url }) : undefined
    if (problem) return { ...navigation, problem }
  }
  return navigation
}

/**
 * What an opened page shows of a refusal or of needing a person, read in a world of its own (the
 * page's scripts can't see it): its HTTP status, title, and whether a human check, a password field
 * or a consent wall is on it.
 */
export async function readPageSigns(cdp: CdpTransport, cdpSessionId: string, frameId: string): Promise<BrowserPageSigns | undefined> {
  const world = await cdp.send<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId, worldName: 'mousse-page-signs' }, { sessionId: cdpSessionId, timeoutMs: 2_000 })
  if (!world.executionContextId) return undefined
  const read = await cdp.send<{ result?: { value?: BrowserPageSigns } }>('Runtime.evaluate', {
    contextId: world.executionContextId,
    returnByValue: true,
    expression: `(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const status = nav && typeof nav.responseStatus === 'number' ? nav.responseStatus : 0
      const frames = [...document.querySelectorAll('iframe[src]')].map((frame) => frame.src)
      const humanCheck = frames.some((src) => /challenges\\.cloudflare\\.com|google\\.com\\/recaptcha|recaptcha\\.net|hcaptcha\\.com|arkoselabs\\.com/i.test(src))
        || !!document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile, .g-recaptcha, .h-captcha')
      const consent = /^consent\\./i.test(location.hostname)
        || !!document.querySelector('#onetrust-consent-sdk [role=dialog], #didomi-popup, #qc-cmp2-container, iframe[id^="sp_message_iframe"]')
      return { status, title: document.title, url: location.href, humanCheck, password: !!document.querySelector('input[type=password]'), consent }
    })()`
  }, { sessionId: cdpSessionId, timeoutMs: 2_000 })
  return read.result?.value
}

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

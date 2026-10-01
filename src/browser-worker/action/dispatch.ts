import type { BrowserAction } from '../../shared/browser/types'
import type { CdpTransport } from '../cdp/transport'
import { BrowserWorkerError, fail } from '../errors'
import { browserNavigationUrl } from '../../shared/browser/validation'
import type { ActionableTarget } from './actionability'
import { readControlValue } from './actionability'

function mouseButton(button?: 'left' | 'right' | 'middle'): 'left' | 'right' | 'middle' {
  return button ?? 'left'
}

async function mouseClick(
  cdp: CdpTransport,
  sessionId: string,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  clickCount: number,
  signal?: AbortSignal
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button }, { sessionId, signal })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, { sessionId, signal })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, { sessionId, signal })
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

/** Wait for the navigation we dispatch, never a replay from about:blank or a child frame. */
export async function navigateAndWaitForLoad(cdp: CdpTransport, cdpSessionId: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const targetUrl = browserNavigationUrl(url)
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, { sessionId: cdpSessionId, signal })
  await new Promise<void>((resolve, reject) => {
    const loaded = new Set<string>()
    let expected: { frameId: string; loaderId?: string } | undefined
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cdp.off('Page.lifecycleEvent', onEvent)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onEvent = (params: unknown, sessionId?: string) => {
      if (sessionId !== cdpSessionId) return
      const event = params as { name?: string; frameId?: string; loaderId?: string }
      if (event.name !== 'load' || !event.frameId || !event.loaderId) return
      const key = `${event.frameId}:${event.loaderId}`
      if (expected && key === `${expected.frameId}:${expected.loaderId}`) finish()
      else if (!expected && loaded.size < 128) loaded.add(key)
    }
    const onAbort = () => finish(new BrowserWorkerError('cancelled', 'Navigation cancelled'))
    const timer = setTimeout(() => finish(new BrowserWorkerError('timeout', 'Navigation did not finish loading')), timeoutMs)
    cdp.on('Page.lifecycleEvent', onEvent)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    void cdp.send<{ frameId: string; loaderId?: string; errorText?: string }>('Page.navigate', { url: targetUrl }, { sessionId: cdpSessionId, timeoutMs, signal }).then((result) => {
      if (settled) return
      if (result.errorText) { finish(new BrowserWorkerError('not_actionable', `Navigation failed: ${result.errorText}`)); return }
      expected = result
      // Same-document navigation has no new loader and the command confirms its commit.
      if (!result.loaderId || loaded.has(`${result.frameId}:${result.loaderId}`)) finish()
    }, finish)
  })
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

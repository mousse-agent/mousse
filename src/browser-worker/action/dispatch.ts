import type { BrowserAction } from '../../shared/browser/types'
import type { CdpConnection } from '../cdp/connection'
import { fail } from '../errors'
import { browserNavigationUrl } from '../../shared/browser/validation'
import type { ActionableTarget } from './actionability'
import { readControlValue } from './actionability'

function mouseButton(button?: 'left' | 'right' | 'middle'): 'left' | 'right' | 'middle' {
  return button ?? 'left'
}

async function mouseClick(
  cdp: CdpConnection,
  sessionId: string,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  clickCount: number
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button }, { sessionId })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, { sessionId })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, { sessionId })
}

async function focus(cdp: CdpConnection, sessionId: string, backendNodeId: number): Promise<void> {
  await cdp.send('DOM.focus', { backendNodeId }, { sessionId })
}

async function selectAll(cdp: CdpConnection, sessionId: string): Promise<void> {
  const modifiers = process.platform === 'darwin' ? 4 : 2
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, { sessionId })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, { sessionId })
}

export async function dispatchAction(
  cdp: CdpConnection,
  cdpSessionId: string,
  action: BrowserAction,
  target: ActionableTarget | undefined
): Promise<void> {
  switch (action.type) {
    case 'navigate':
      await cdp.send('Page.navigate', { url: browserNavigationUrl(action.url) }, { sessionId: cdpSessionId, timeoutMs: 30_000 })
      return
    case 'reload':
      await cdp.send('Page.reload', {}, { sessionId: cdpSessionId })
      return
    case 'back':
    case 'forward': {
      const history = await cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory', {}, { sessionId: cdpSessionId })
      const next = action.type === 'back' ? history.currentIndex - 1 : history.currentIndex + 1
      const entry = history.entries[next]
      if (!entry) fail('not_actionable', `No ${action.type} history entry`)
      await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, { sessionId: cdpSessionId })
      return
    }
    case 'click':
    case 'double-click':
    case 'hover': {
      if (!target) fail('invalid_action', 'Pointer action requires a target')
      if (target.disabled) fail('not_actionable', 'Target is disabled')
      if (action.type === 'hover') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.point.x, y: target.point.y }, { sessionId: cdpSessionId })
        return
      }
      await mouseClick(cdp, cdpSessionId, target.point.x, target.point.y, mouseButton(action.button), action.type === 'double-click' ? 2 : 1)
      return
    }
    case 'fill':
    case 'type': {
      if (!target) fail('invalid_action', 'Text action requires a target')
      if (target.disabled || target.readOnly) fail('not_actionable', 'Target is not editable')
      await focus(cdp, cdpSessionId, target.backendNodeId)
      await mouseClick(cdp, cdpSessionId, target.point.x, target.point.y, 'left', 1)
      if (action.type === 'fill') {
        await cdp.send('Runtime.callFunctionOn', {
          objectId: target.objectId,
          functionDeclaration: 'function() { if (this.select) this.select(); }'
        }, { sessionId: cdpSessionId })
        await selectAll(cdp, cdpSessionId)
      }
      if (action.text) await cdp.send('Input.insertText', { text: action.text }, { sessionId: cdpSessionId })
      return
    }
    case 'key': {
      if (target) await focus(cdp, cdpSessionId, target.backendNodeId)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, text: action.key.length === 1 ? action.key : undefined }, { sessionId: cdpSessionId })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key }, { sessionId: cdpSessionId })
      return
    }
    case 'select': {
      if (!target) fail('invalid_action', 'Select requires a target')
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
      }, { sessionId: cdpSessionId })
      return
    }
    case 'check': {
      if (!target) fail('invalid_action', 'Check requires a target')
      if (target.disabled) fail('not_actionable', 'Target is disabled')
      const current = await readControlValue(cdp, cdpSessionId, target.objectId)
      if (!!current.checked !== action.checked) {
        await mouseClick(cdp, cdpSessionId, target.point.x, target.point.y, 'left', 1)
      }
      return
    }
    case 'scroll': {
      const x = target?.point.x ?? 10
      const y = target?.point.y ?? 10
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: action.deltaX, deltaY: action.deltaY }, { sessionId: cdpSessionId })
      return
    }
    case 'drag':
      fail('unsupported', 'Drag is not certified in this worker revision')
      return
    case 'upload':
      fail('unsupported', 'Upload requires an MMS-staged artifact file grant that is not wired in this worker revision')
      return
    case 'dialog':
      await cdp.send('Page.handleJavaScriptDialog', { accept: action.accept, ...(action.promptText === undefined ? {} : { promptText: action.promptText }) }, { sessionId: cdpSessionId })
      return
    default:
      fail('unsupported', 'Unsupported action')
  }
}

export async function waitForLoad(cdp: CdpConnection, cdpSessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
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

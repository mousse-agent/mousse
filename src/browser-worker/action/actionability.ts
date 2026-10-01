import type { BrowserBounds, BrowserPoint } from '../../shared/browser/types'
import type { CdpTransport } from '../cdp/transport'
import { fail } from '../errors'
import { sleep } from '../util'
import type { ObservedNode } from '../observation/ReferenceStore'

export interface ActionableTarget {
  cdpSessionId: string
  backendNodeId: number
  objectId: string
  point: BrowserPoint
  bounds: BrowserBounds
  disabled: boolean
  hidden: boolean
  readOnly: boolean
  tag: string
  type: string
  secret: boolean
}

export interface CoordinateTarget extends ActionableTarget {
  point: BrowserPoint
}

interface ControlState {
  tag: string
  type: string
  disabled: boolean
  readOnly: boolean
  hidden: boolean
  valueLength: number
  checked?: boolean
}

const TRUSTED_STATE = `function() {
  const el = this && this.nodeType === 3 ? this.parentElement : this;
  if (!el || el.nodeType !== 1) return null;
  const cs = globalThis.getComputedStyle(el);
  const type = el instanceof HTMLInputElement ? el.type : '';
  return {
    tag: el.tagName || '',
    type,
    disabled: !!(el.disabled),
    readOnly: !!(el.readOnly),
    hidden: cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0,
    valueLength: typeof el.value === 'string' ? el.value.length : 0,
    checked: !!(el.checked)
  };
}`

const TRUSTED_HIT = `function(x, y) {
  const el = this && this.nodeType === 3 ? this.parentElement : this;
  if (!el || el.nodeType !== 1) return { ok: false, occluded: true, hitTag: '', hitText: '' };
  const root = el.getRootNode && el.getRootNode();
  const hit = root && typeof root.elementFromPoint === 'function' ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
  if (!hit) return { ok: false, occluded: true, hitTag: '', hitText: '' };
  const ok = el === hit || el.contains(hit);
  return { ok, occluded: !ok, hitTag: hit.tagName || '', hitText: String(hit.innerText || hit.getAttribute('aria-label') || '').slice(0, 80) };
}`

async function resolveObject(cdp: CdpTransport, sessionId: string, backendNodeId: number, signal?: AbortSignal): Promise<string> {
  const resolved = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, { sessionId, signal })
  if (!resolved.object?.objectId) fail('stale_ref', 'Observed node is no longer attached')
  return resolved.object.objectId
}

async function quads(cdp: CdpTransport, sessionId: string, backendNodeId: number, signal?: AbortSignal): Promise<BrowserBounds> {
  const result = await cdp.send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId }, { sessionId, signal })
  const quad = result.quads?.[0]
  if (!quad || quad.length < 8) fail('not_actionable', 'Target has no visible geometry')
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const width = Math.max(...xs) - x
  const height = Math.max(...ys) - y
  if (width < 1 || height < 1) fail('not_actionable', 'Target geometry is empty')
  return { x, y, width, height }
}

function sameBounds(a: BrowserBounds, b: BrowserBounds): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
}

export async function prepareActionableTarget(
  cdp: CdpTransport,
  cdpSessionId: string,
  node: ObservedNode,
  signal?: AbortSignal
): Promise<ActionableTarget> {
  await cdp.send('DOM.enable', {}, { sessionId: cdpSessionId, signal })
  try {
    await cdp.send('DOM.describeNode', { backendNodeId: node.backendNodeId }, { sessionId: cdpSessionId, signal })
  } catch {
    fail('stale_ref', 'Observed node is detached')
  }
  try {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }, { sessionId: cdpSessionId, signal })
  } catch {
    fail('not_actionable', 'Target could not be scrolled into view')
  }
  const first = await quads(cdp, cdpSessionId, node.backendNodeId, signal)
  await sleep(50, signal)
  const second = await quads(cdp, cdpSessionId, node.backendNodeId, signal)
  if (!sameBounds(first, second)) fail('not_actionable', 'Target geometry is not stable')
  const objectId = await resolveObject(cdp, cdpSessionId, node.backendNodeId, signal)
  const state = await cdp.send<{ result: { value?: ControlState } }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: TRUSTED_STATE,
    returnByValue: true
  }, { sessionId: cdpSessionId, signal })
  const value = state.result?.value
  if (!value) fail('stale_ref', 'Observed node could not be resolved')
  if (value.hidden) fail('not_actionable', 'Target is hidden')
  const point = { x: second.x + second.width / 2, y: second.y + second.height / 2 }
  const hit = await cdp.send<{ result: { value?: { ok?: boolean; occluded?: boolean; hitTag?: string; hitText?: string } } }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: TRUSTED_HIT,
    arguments: [{ value: point.x }, { value: point.y }],
    returnByValue: true
  }, { sessionId: cdpSessionId, signal })
  const hitValue = hit.result?.value
  if (!hitValue?.ok) {
    fail('not_actionable', `Click intercepted by overlay${hitValue?.hitTag ? ` (${hitValue.hitTag}: ${hitValue.hitText ?? ''})` : ''}`)
  }
  return {
    cdpSessionId: cdpSessionId,
    backendNodeId: node.backendNodeId,
    objectId,
    point,
    bounds: second,
    disabled: value.disabled,
    hidden: value.hidden,
    readOnly: value.readOnly,
    tag: value.tag,
    type: value.type,
    secret: value.type === 'password'
  }
}

export async function readControlValue(
  cdp: CdpTransport,
  cdpSessionId: string,
  objectId: string,
  signal?: AbortSignal
): Promise<{ value: string; valueLength: number; type: string; checked?: boolean; selected?: string[] }> {
  const result = await cdp.send<{ result: { value?: { value?: string; valueLength?: number; type?: string; checked?: boolean; selected?: string[] } } }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      const el = this;
      const type = el instanceof HTMLInputElement ? el.type : '';
      const secret = type === 'password';
      const selected = el instanceof HTMLSelectElement ? [...el.options].filter((o) => o.selected).map((o) => o.value) : [];
      return {
        value: secret ? '' : String(el.value ?? ''),
        valueLength: typeof el.value === 'string' ? el.value.length : 0,
        type,
        checked: !!(el.checked),
        selected
      };
    }`,
    returnByValue: true
  }, { sessionId: cdpSessionId, signal })
  return {
    value: result.result?.value?.value ?? '',
    valueLength: result.result?.value?.valueLength ?? 0,
    type: result.result?.value?.type ?? '',
    checked: result.result?.value?.checked,
    selected: result.result?.value?.selected
  }
}

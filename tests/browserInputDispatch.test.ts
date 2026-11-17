import { describe, expect, it } from 'vitest'
import { dispatchAction, dispatchHumanInput } from '../src/browser-worker/action/dispatch'
import type { CdpTransport } from '../src/browser-worker/cdp/transport'
import type { ActionableTarget } from '../src/browser-worker/action/actionability'

function recordingTransport() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  const cdp: CdpTransport = {
    connected: true,
    send: async <T>(method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params })
      return {} as T
    },
    on: () => undefined,
    off: () => undefined
  }
  return { cdp, mouse: () => sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.params) }
}

describe('a click as a mouse makes one', () => {
  it("the owner's click arrives with no button held, presses, then releases", async () => {
    const { cdp, mouse } = recordingTransport()
    await dispatchHumanInput(cdp, 'session', { kind: 'click', x: 213, y: 337 })
    expect(mouse()).toEqual([
      { type: 'mouseMoved', x: 213, y: 337, button: 'none', buttons: 0 },
      { type: 'mousePressed', x: 213, y: 337, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 213, y: 337, button: 'left', buttons: 0, clickCount: 1 }
    ])
  })

  it("the agent's right click holds the right button only while it is down", async () => {
    const { cdp, mouse } = recordingTransport()
    const target = { point: { x: 40, y: 50 }, disabled: false } as unknown as ActionableTarget
    await dispatchAction(cdp, 'session', { type: 'click', button: 'right', target: { kind: 'ref', ref: 'r1' } } as never, target)
    expect(mouse().map((event) => [event.type, event.button, event.buttons])).toEqual([
      ['mouseMoved', 'none', 0],
      ['mousePressed', 'right', 2],
      ['mouseReleased', 'right', 0]
    ])
  })
})

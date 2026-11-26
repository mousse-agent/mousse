/**
 * Who may call what (design §4.3, row M6): this computer's windows call the new networking's local methods, and a
 * paired computer calls only `ENGINE_OWNER_METHODS`, the routed thread and terminal calls and what they need.
 */
import { describe, expect, it } from 'vitest'
import { PLATFORM_REQUEST_METHODS } from '../../src/main/ipc/registerGuiIpc'
import {
  ROUTED_METHODS,
  ROUTED_TRANSPORT_METHODS,
  routedNetMethod
} from '../../src/shared/bridge/routed'
import { NET_LOCAL_METHODS } from '../../src/shared/net/local'
import { ENGINE_OWNER_METHODS } from '../../src/shared/netEngine/allowlist'
import { NET_ENGINE_LOCAL_METHODS } from '../../src/shared/netEngine/local'
import { UPDATE_NET_METHODS } from '../../src/shared/remoteUpdates'

describe('the engine allow-lists', () => {
  it('lets a window call every local method of the new networking', () => {
    for (const method of NET_ENGINE_LOCAL_METHODS)
      expect(PLATFORM_REQUEST_METHODS.has(method)).toBe(true)
  })

  it('keeps every local method, of either networking, off what a paired computer may call', () => {
    for (const method of [...NET_ENGINE_LOCAL_METHODS, ...NET_LOCAL_METHODS])
      expect(ENGINE_OWNER_METHODS.has(method), method).toBe(false)
  })

  it('lets a paired computer call the routed rows, three transport calls, staging, net.info, its access, dispatch and updates, and nothing else', () => {
    const expected = new Set([
      // The editor rows included (Phase 1b §9.1).
      ...Object.keys(ROUTED_METHODS).map(routedNetMethod),
      routedNetMethod('stream.open'),
      routedNetMethod('stream.close'),
      routedNetMethod('page'),
      routedNetMethod('stage'),
      'bridge.artifacts.open',
      'net.info',
      'bridge.access.mine',
      'bridge.dispatch',
      // Held to Full control by the per-device policy (`checkNodePolicy`).
      ...UPDATE_NET_METHODS
    ])
    expect([...ENGINE_OWNER_METHODS].sort()).toEqual([...expected].sort())
    // The transport calls it takes are routed ones; the local tunnel methods and Spaces are not on it.
    for (const method of ['stream.open', 'stream.close', 'page'])
      expect(Object.keys(ROUTED_TRANSPORT_METHODS)).toContain(method)
    expect(ENGINE_OWNER_METHODS.has(routedNetMethod('editor.folder'))).toBe(true)
    for (const method of ENGINE_OWNER_METHODS)
      expect(method).not.toMatch(/tunnel|spaces|^net\.(?!info$)/)
  })
})

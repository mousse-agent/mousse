/**
 * Who may update this computer from another one (#476): Full control and not blocked, on either network. The rule
 * sits in `checkNodePolicy`, which v1 sessions and engine pairings both run on every call.
 */
import { expect, it } from 'vitest'
import { checkNodePolicy } from '../../src/mms/net/checkNodePolicy'
import type { NodePolicy } from '../../src/mms/net/store/nodePolicy'
import { NetError, type NodeId } from '../../src/shared/net'
import { accessPreset } from '../../src/shared/net/accessPresets'
import { UPDATE_NET_METHODS } from '../../src/shared/remoteUpdates'

const node = 'node_test' as NodeId
const base = { node, blocked: false, ...accessPreset('full').fields } as unknown as NodePolicy

const rows: Array<[string, Partial<NodePolicy>, string | undefined]> = [
  ['Full control', {}, undefined],
  // The bot level is not one of the fields that make Full control.
  ['Full control, bots Use', { bots: 'use' }, undefined],
  ['Full control, bots Off', { bots: 'off' }, undefined],
  ['Work on threads, bots Full', { ...accessPreset('work').fields, bots: 'full' }, 'full_control_needed'],
  ['Full control, blocked', { blocked: true }, 'blocked'],
  ['Work on threads', accessPreset('work').fields, 'full_control_needed'],
  ['View and chat', accessPreset('view').fields, 'full_control_needed'],
  ['Custom: full but no terminal', { terminal: false }, 'full_control_needed'],
  ['Custom: full but agents reach launched threads only', { agentReach: 'launched' }, 'full_control_needed']
]

it.each(rows)('%s', (_label, patch, refused) => {
  const policy = { ...base, ...patch } as NodePolicy
  const store = { isBlocked: () => policy.blocked, get: () => policy }
  for (const method of UPDATE_NET_METHODS) {
    const call = () => checkNodePolicy({ method }, node, store, { workOnThreads: true })
    if (!refused) expect(call, method).not.toThrow()
    else {
      const error = (() => {
        try {
          call()
        } catch (caught) {
          return caught
        }
      })() as NetError
      expect(error, method).toBeInstanceOf(NetError)
      expect(error.code).toBe('forbidden')
      expect(error.details).toEqual({ reason: refused })
    }
  }
})

/**
 * The turns a restart of this computer stops, as the desktop app asks its service before it shows the restart prompt
 * (`updates.remote.turns`): every profile's running turns, for the desktop app's connection only.
 */
import { describe, expect, it } from 'vitest'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import { registerRemoteUpdateMethods } from '../../src/mms/updates/registerRemoteUpdateMethods'
import { RemoteUpdates } from '../../src/mms/updates/remoteUpdates'
import { REMOTE_UPDATE_APP_METHODS } from '../../src/shared/remoteUpdates'

const setup = (count: () => number) => {
  const registry = new DomainHandlerRegistry()
  registerRemoteUpdateMethods(registry, new RemoteUpdates(), { emit: () => undefined, activeTurns: count })
  const ask = (clientType: string) =>
    registry.dispatch({ connection: { id: 'c1', clientType, capabilities: new Set<string>() } } as unknown as HandlerContext, REMOTE_UPDATE_APP_METHODS.turns, {})
  return { ask }
}

describe('updates.remote.turns', () => {
  it('answers the turns running in every profile now, to the desktop app', async () => {
    let running = 3
    const { ask } = setup(() => running)
    expect(await ask('gui')).toEqual({ runningTurns: 3 })
    running = 0
    expect(await ask('gui')).toEqual({ runningTurns: 0 })
  })

  it('reads none when counting fails, and refuses anything but the desktop app', async () => {
    const { ask } = setup(() => {
      throw new Error('profile closing')
    })
    expect(await ask('gui')).toEqual({ runningTurns: 0 })
    await expect(ask('cli')).rejects.toThrow(/desktop app/)
  })
})

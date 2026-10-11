import { expect, it } from 'vitest'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import { registerBotMethods } from '../../../../src/mms/bots/registerMethods'
import type { HandlerContext } from '../../../../src/mms/protocol/handlers'
import { NET_ERRORS, NetError, newId } from '../../../../src/shared/net'

function context(
  binding?: { profileId: string; epoch: number },
  capabilities: string[] = ['net.v1']
): HandlerContext {
  return {
    connection: { id: 'owner-local', binding, capabilities: new Set(capabilities) }
  } as HandlerContext
}
it('requires local capability and trusted binding before accessing a profile or accepting exact local fields', async () => {
  const registry = new DomainHandlerRegistry()
  let accesses = 0
  registerBotMethods(registry, () => {
    accesses++
    throw new Error('Unexpected profile access')
  })
  registry.seal()
  await expect(registry.dispatch(context(), 'bots.list', {})).rejects.toMatchObject({
    code: 'profile_binding_required'
  })
  await expect(
    registry.dispatch(context({ profileId: 'a', epoch: 1 }, []), 'bots.list', {})
  ).rejects.toMatchObject({ code: 'capability_required' })
  await expect(
    registry.dispatch(context({ profileId: 'a', epoch: 1 }), 'bots.list', { profileId: 'b' })
  ).rejects.toMatchObject({ code: 'profile_mismatch' })
  await expect(
    registry.dispatch(context({ profileId: 'a', epoch: 1 }), 'bots.list', {
      after: { space: newId('space'), bot: newId('bot'), epoch: 2 }
    })
  ).rejects.toMatchObject({ code: 'bad_request' })
  await expect(
    registry.dispatch(context({ profileId: 'a', epoch: 1 }), 'bots.configure', {
      path: '/tmp/private',
      native: { definition: 'code' },
      qualified: true
    })
  ).rejects.toMatchObject({ code: 'bad_request' })
  expect(accesses).toBe(0)
})
it('publishes bounded static errors even when trusted local provider failures contain sensitive text', async () => {
  for (const error of [
    new NetError('forbidden', 'sensitive local provider text'),
    new Error('sensitive local provider text')
  ]) {
    const registry = new DomainHandlerRegistry()
    registerBotMethods(registry, () => ({
      request: () => {
        throw error
      }
    }))
    registry.seal()
    const failure = await registry
      .dispatch(context({ profileId: 'a', epoch: 1 }), 'bots.list', {})
      .then(
        () => undefined,
        (error) => error
      )
    const code = error instanceof NetError ? 'forbidden' : 'internal'
    expect(failure.code).toBe(code)
    expect(failure.message).toBe(NET_ERRORS[code].message)
  }
})

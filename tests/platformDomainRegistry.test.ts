import { describe, expect, it, vi } from 'vitest'
import { DomainHandlerRegistry, domainObject } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { validateRequest } from '../src/mms/protocol/validators'

function fixture(scope: 'profile' | 'installation' = 'profile') {
  const registry = new DomainHandlerRegistry()
  const handle = vi.fn((_ctx, params, binding) => ({ params, binding }))
  registry.register({ method: 'fixture.read', scope, capability: 'fixture-v1', requiredCapabilities: ['fixture:read'], validate: (params) => domainObject(params, ['profileId', 'id']), handle })
  const context = { connection: { id: 'test', binding: { profileId: 'profile-a', epoch: 2 }, capabilities: new Set(['fixture:read']) } } as HandlerContext
  return { registry, handle, context }
}

describe('per-daemon domain dispatch seam', () => {
  it('allows only registered methods and never modifies another daemon registry', () => {
    const { registry } = fixture()
    const request = { kind: 'req', id: '1', method: 'fixture.read', params: {} }
    expect(validateRequest(request).ok).toBe(false)
    expect(validateRequest(request, registry.methods()).ok).toBe(true)
    expect(validateRequest(request, new DomainHandlerRegistry().methods()).ok).toBe(false)
    expect(registry.capabilities()).toEqual(['fixture-v1'])
    registry.seal()
    expect(() => registry.register({ method: 'fixture.other', scope: 'installation', validate: () => ({}), handle: () => null })).toThrow('sealed')
  })

  it('captures a validated daemon binding and rejects cross-profile claims before side effects', async () => {
    const { registry, context, handle } = fixture()
    const result = await registry.dispatch(context, 'fixture.read', { profileId: 'profile-a', id: 'object' }) as { binding: object }
    expect(result.binding).toEqual({ profileId: 'profile-a', epoch: 2 })
    expect(Object.isFrozen(result.binding)).toBe(true)
    handle.mockClear()
    await expect(registry.dispatch(context, 'fixture.read', { profileId: 'profile-b' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('allows installation-scoped lifecycle methods to name their target profile', async () => {
    const { registry, context } = fixture('installation')
    await expect(registry.dispatch(context, 'fixture.read', { profileId: 'profile-b' })).resolves.toMatchObject({
      params: { profileId: 'profile-b' }
    })
  })

  it('rejects unbound or unauthorized calls', async () => {
    const { registry, context, handle } = fixture()
    await expect(registry.dispatch({ ...context, connection: undefined }, 'fixture.read', {})).rejects.toMatchObject({ code: 'profile_binding_required' })
    await expect(registry.dispatch({ ...context, connection: { ...context.connection!, capabilities: new Set() } }, 'fixture.read', {})).rejects.toMatchObject({ code: 'capability_required' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('rejects unknown keys, prototype-bearing objects and oversized payloads', async () => {
    const { registry, context, handle } = fixture()
    await expect(registry.dispatch(context, 'fixture.read', { forgedRole: 'owner' })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(registry.dispatch(context, 'fixture.read', { id: 'x'.repeat(600_000) })).rejects.toMatchObject({ code: 'params_too_large' })
    expect(() => domainObject(JSON.parse('{"__proto__":{}}'), ['__proto__'])).toThrow('Unexpected field')
    expect(() => domainObject(Object.create({ injected: true }), [])).toThrow('Expected a JSON object')
    expect(handle).not.toHaveBeenCalled()
  })

  it('does not allow extension handlers to replace legacy methods', () => {
    const registry = new DomainHandlerRegistry()
    expect(() => registry.register({ method: 'threads.get', scope: 'profile', validate: () => null, handle: () => null })).toThrow('Duplicate')
  })
})

import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import type { TrustedProfileBinding } from '../protocol/domainRegistry'
import { PROFILES_V1_CAPABILITY } from '../../shared/profiles/types'
import { canonicalizeProfileSlug } from '../../shared/profiles/ids'
import { asBoundedInt, asOptionalString, asString } from '../protocol/validators'
import type { MousseMainService } from '../MousseMainService'

function hostOf(ctx: HandlerContext) {
  const host = ctx.mms.getInstallationHost()
  if (!host) throw new DomainRpcError('unavailable', 'Profile host is not available')
  return host
}

function mainOf(ctx: HandlerContext): MousseMainService {
  const host = ctx.mms.getInstallationHost()
  if (!host) throw new DomainRpcError('unavailable', 'Profile host is not available')
  return ctx.mms as MousseMainService
}

export function registerProfileDomain(registry: DomainHandlerRegistry, _main: MousseMainService): void {
  registry.register({
    method: 'profiles.list',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      if (params === undefined || params === null) return {}
      return domainObject(params, [])
    },
    handle: (ctx) => {
      const host = hostOf(ctx)
      return {
        defaultProfileId: host.getDefaultProfileId(),
        profiles: host.manager.list().map((record) => host.toPublic(record))
      }
    }
  })

  registry.register({
    method: 'profiles.status',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      if (params === undefined || params === null) return {}
      return domainObject(params, [])
    },
    handle: (ctx) => {
      const host = hostOf(ctx)
      return {
        defaultProfileId: host.getDefaultProfileId(),
        activeCount: host.activeProfileCount(),
        binding: ctx.connection?.binding ?? null,
        singleProfileLegacyClients: host.activeProfileCount() <= 1
      }
    }
  })

  registry.register({
    method: 'profiles.create',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      const raw = domainObject(params, ['displayName', 'slug', 'color', 'avatar'])
      return {
        displayName: asString(raw.displayName, 'displayName', 64),
        slug: asOptionalString(raw.slug, 64),
        color: asOptionalString(raw.color, 32),
        avatar: asOptionalString(raw.avatar, 4096)
      }
    },
    handle: async (ctx, input) => {
      const host = hostOf(ctx)
      const record = host.manager.create({
        displayName: input.displayName,
        slug: input.slug,
        color: input.color,
        avatar: input.avatar
      })
      const services = await host.getProfileServices(record.id)
      await services.start()
      return { profile: host.toPublic(record) }
    }
  })

  registry.register({
    method: 'profiles.update',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      const raw = domainObject(params, ['profileId', 'expectedRevision', 'displayName', 'slug', 'color', 'avatar'])
      return {
        profileId: asString(raw.profileId, 'profileId', 64),
        expectedRevision: asBoundedInt(raw.expectedRevision, 'expectedRevision', { min: 1, max: Number.MAX_SAFE_INTEGER }),
        displayName: asOptionalString(raw.displayName, 64),
        slug: raw.slug === undefined ? undefined : canonicalizeProfileSlug(asString(raw.slug, 'slug', 64)),
        color: asOptionalString(raw.color, 32),
        avatar: asOptionalString(raw.avatar, 4096)
      }
    },
    handle: (ctx, input) => {
      const host = hostOf(ctx)
      const record = host.manager.update(
        input.profileId,
        {
          displayName: input.displayName,
          slug: input.slug,
          color: input.color,
          avatar: input.avatar
        },
        input.expectedRevision
      )
      return { profile: host.toPublic(record) }
    }
  })

  registry.register({
    method: 'profiles.bind',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      const raw = domainObject(params, ['profile'])
      return { profile: asString(raw.profile, 'profile', 64) }
    },
    handle: async (ctx, input, binding) => {
      void binding
      const host = hostOf(ctx)
      const main = mainOf(ctx)
      const record = host.manager.get(input.profile)
      if (record.status !== 'active') {
        throw new DomainRpcError('profile_archived', 'Profile is not active')
      }
      await main.getProfileServices(record.id)
      const next: TrustedProfileBinding = {
        profileId: record.id,
        epoch: (ctx.connection?.binding?.epoch ?? 0) + 1
      }
      if (ctx.connection && 'bind' in ctx.connection && typeof (ctx.connection as { bind?: unknown }).bind === 'function') {
        ;(ctx.connection as { bind: (value: TrustedProfileBinding) => void }).bind(next)
      }
      return {
        profile: host.toPublic(record),
        epoch: next.epoch,
        home: host.manager.getPaths(record.id).root
      }
    }
  })

  registry.register({
    method: 'profiles.archive',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      const raw = domainObject(params, ['profileId', 'expectedRevision'])
      return {
        profileId: asString(raw.profileId, 'profileId', 64),
        expectedRevision: asBoundedInt(raw.expectedRevision, 'expectedRevision', { min: 1, max: Number.MAX_SAFE_INTEGER })
      }
    },
    handle: async (ctx, input) => {
      const host = hostOf(ctx)
      await host.disposeProfile(input.profileId)
      const record = host.manager.archive(input.profileId, input.expectedRevision)
      host.shared.domains.notifyProfileDisposed(record.id)
      return { profile: host.toPublic(record) }
    }
  })

  registry.register({
    method: 'profiles.restore',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      const raw = domainObject(params, ['profileId', 'expectedRevision'])
      return {
        profileId: asString(raw.profileId, 'profileId', 64),
        expectedRevision: asBoundedInt(raw.expectedRevision, 'expectedRevision', { min: 1, max: Number.MAX_SAFE_INTEGER })
      }
    },
    handle: async (ctx, input) => {
      const host = hostOf(ctx)
      const record = host.manager.restore(input.profileId, input.expectedRevision)
      const services = await host.getProfileServices(record.id)
      await services.start()
      return { profile: host.toPublic(record) }
    }
  })

  registry.register({
    method: 'profiles.removePreview',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      const raw = domainObject(params, ['profileId'])
      return { profileId: asString(raw.profileId, 'profileId', 64) }
    },
    handle: (ctx, input) => hostOf(ctx).previewRemove(input.profileId)
  })

  registry.register({
    method: 'profiles.remove',
    scope: 'installation',
    capability: PROFILES_V1_CAPABILITY,
    requiredCapabilities: [PROFILES_V1_CAPABILITY],
    validate: (params) => {
      const raw = domainObject(params, ['profileId', 'expectedRevision'])
      return {
        profileId: asString(raw.profileId, 'profileId', 64),
        expectedRevision: asBoundedInt(raw.expectedRevision, 'expectedRevision', { min: 1, max: Number.MAX_SAFE_INTEGER })
      }
    },
    handle: async (ctx, input) => {
      const host = hostOf(ctx)
      const preview = host.previewRemove(input.profileId)
      const result = await host.remove(input.profileId, input.expectedRevision)
      host.shared.domains.notifyProfileDisposed(preview.profileId)
      return result
    }
  })
}

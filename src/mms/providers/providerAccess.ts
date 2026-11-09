import { AppError } from '../../shared/errors'
import type { ProviderTranscriptionRequest, ProviderTranscriptionResult } from '../../shared/dictation'
import type { ProviderAuthType, ProvidersUsageResponse, ProviderUsage } from '../../shared/providerAuth'
import type { ProviderSpeechRequest, ProviderSpeechResult } from '../../shared/readAloud'
import type { ProviderAuthService } from './ProviderAuthService'

export const PROVIDER_REMOVED_CODE = 'provider_removed'

/** A provider removed from this profile is used for nothing, even while another profile keeps its shared key. */
export class ProviderRemovedError extends AppError {
  constructor(label: string, readonly providerId: string) {
    super({
      code: PROVIDER_REMOVED_CODE,
      message: `${label} was removed from this profile. Add it again in Settings → Providers.`,
      errorInfo: { category: 'invalid', retryable: false }
    })
    this.name = 'ProviderRemovedError'
  }
}

/** The shared calls `providerAccess` guards; `ProviderAuthService` stays profile-free. */
export type SharedProviderCalls = Pick<
  ProviderAuthService,
  'synthesizeSpeech' | 'transcribeAudio' | 'getSubscriptionUsage' | 'getUsage' | 'getProviderDisplayName' | 'getConfiguredProviders'
>

/** What `providerAccess` asks the profile's instance map. */
export interface ProfileInstances {
  isRemoved(instanceId: string): boolean
  /** Turned off on this computer: the usage page leaves it out. */
  isDisabled?(instanceId: string): boolean
  instanceIdForLegacyProvider(llmProvider: string): string
}

/**
 * A profile's one way to the shared speech and usage calls. Each call first checks that the
 * provider was not removed from this profile: the credentials are installation-wide, so without
 * this a provider removed here would still speak and report usage with another profile's key.
 */
export interface ProviderAccess {
  synthesizeSpeech(request: ProviderSpeechRequest): Promise<ProviderSpeechResult>
  transcribeAudio(request: ProviderTranscriptionRequest): Promise<ProviderTranscriptionResult>
  /** Usage text for one provider (the usage view); undefined without a usage reader. */
  subscriptionUsage(providerId: string): Promise<string | undefined>
  /** Usage of every credentialed provider, without the ones removed from this profile. */
  usage(): Promise<ProvidersUsageResponse>
  /** The credentialed providers the usage page lists, without reading any. */
  usageSlots(): Array<{ id: string; label: string; authType?: ProviderAuthType }>
  /** One credentialed provider's usage; undefined for one removed from this profile or not credentialed. */
  usageFor(providerId: string): Promise<ProviderUsage | undefined>
}

export function createProviderAccess(auth: SharedProviderCalls, instances: ProfileInstances): ProviderAccess {
  const removed = (providerId: string): boolean => {
    let instanceId: string
    try {
      instanceId = instances.instanceIdForLegacyProvider(providerId)
    } catch {
      // A name no instance maps to was never added here, so it was not removed either.
      return false
    }
    return instances.isRemoved(instanceId)
  }
  // A provider turned off in Settings is not shown on the usage page (nor read for it).
  const disabled = (providerId: string): boolean => {
    try {
      return instances.isDisabled?.(instances.instanceIdForLegacyProvider(providerId)) ?? false
    } catch {
      return false
    }
  }
  const refuseRemoved = (providerId: string): void => {
    if (removed(providerId)) throw new ProviderRemovedError(auth.getProviderDisplayName(providerId), providerId)
  }
  return {
    synthesizeSpeech: async (request) => {
      refuseRemoved(request.providerId)
      return auth.synthesizeSpeech(request)
    },
    transcribeAudio: async (request) => {
      refuseRemoved(request.providerId)
      return auth.transcribeAudio(request)
    },
    subscriptionUsage: async (providerId) => {
      refuseRemoved(providerId.trim())
      return auth.getSubscriptionUsage(providerId)
    },
    // A removed provider's usage is not read at all (no request with the shared key).
    usage: () => auth.getUsage((providerId) => !removed(providerId)),
    usageSlots: () => auth.getConfiguredProviders().filter((provider) => !removed(provider.id) && !disabled(provider.id)).map((provider) => ({ id: provider.id, label: provider.label, authType: provider.authType })),
    usageFor: async (providerId) => (removed(providerId) || disabled(providerId) ? undefined : (await auth.getUsage((id) => id === providerId)).providers[0])
  }
}

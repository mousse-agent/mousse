import type { TransportAddon, Transport, Clock } from '../contracts'
import { HostedRelayTransport } from '../plus/wire/client'
import { canonicalAudience } from '../plus/wire/protocol'
import { NetError, isNetErrorCode } from '../../../shared/net'
import type { RelayIdentity } from '../relay/protocol'
import type { HostedProfileService } from '../plus/HostedProfileService'
export function createPlusRelayAddon(
  identity: () => RelayIdentity,
  hosted: () => HostedProfileService
): TransportAddon {
  return {
    manifest: {
      id: 'plus-relay',
      kind: 'transport',
      displayName: 'Mousse Plus',
      traits: { canListen: true, canDial: true, readsPlaintext: true, needsAccount: true },
      settingsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['address'],
        properties: {
          address: { type: 'string', minLength: 1, maxLength: 4096 },
          priority: { type: 'integer', minimum: 0, maximum: 1000 }
        }
      },
      setupSteps: [
        {
          title: 'Connect your Mousse ID',
          detail:
            'Use the profile’s daemon CLI to bind your protected Net identity and explicitly connect Plus. Pinned peer TLS keeps content private from the relay.'
        }
      ]
    },
    create: (settings) => {
      const { address, priority } = settings as { address: string; priority?: number }
      const inner = new HostedRelayTransport({
        id: 'plus-relay',
        audience: canonicalAudience(address),
        identity,
        registration: () => hosted().registration(address),
        priority
      })
      const mapped = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work()
        } catch (error) {
          const code = (error as { code?: unknown })?.code
          throw new NetError(isNetErrorCode(code) ? code : 'route_unreachable')
        }
      }
      return {
        id: inner.id,
        traits: inner.traits,
        status: () => inner.status(),
        onStatus: (listener) => inner.onStatus(listener),
        provision: () => mapped(() => inner.provision()),
        listen: (accept) => mapped(() => inner.listen(accept)),
        dial: (route, signal) => mapped(() => inner.dial(route, signal)),
        teardown: () => inner.teardown()
      } satisfies Transport
    }
  }
}

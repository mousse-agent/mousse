import type { ComputerUseSetupRequestView, ComputerUseStatus } from '../../shared/computerUse'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import type { ComputerUseDriver } from './ComputerUseDriver'
import type { ComputerUseSetupRequests } from './ComputerUseSetupRequests'

const id = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value || value.length > 256) throw new DomainRpcError('invalid_params', `${what} is required`)
  return value
}

/** What the methods reach in a profile: its Cua Driver and its setup cards. */
export interface ComputerUseServices {
  driver: ComputerUseDriver
  setup: ComputerUseSetupRequests
}

/**
 * Settings → Computer use: `computerUse.status` says whether Cua Driver is here (with `refresh`, it looks again now);
 * `computerUse.install` runs the official installer. Only a person at a window of this computer installs software.
 * `computerUse.setupRequest.get` and `.dismiss` read and close the setup card an agent's `computer_use_request` opened
 * in a thread. All of them stay on this computer (`routed.ts`: the `computerUse.` prefix is never routed).
 */
export function registerComputerUseMethods(domains: DomainHandlerRegistry, servicesFor: (profileId: string) => Promise<ComputerUseServices>): void {
  const bound = async (binding: { profileId: string } | undefined) => {
    if (!binding) throw new DomainRpcError('profile_required', 'Computer use needs a profile')
    return await servicesFor(binding.profileId)
  }
  domains.register({
    method: 'computerUse.status',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'refresh'])
      return { refresh: raw.refresh === true }
    },
    handle: async (_context, params, binding): Promise<ComputerUseStatus> => await (await bound(binding)).driver.status(params.refresh)
  })
  domains.register({
    method: 'computerUse.install',
    scope: 'profile',
    validate: (params) => domainObject(params ?? {}, ['profileId']),
    handle: async (context: HandlerContext, _params, binding): Promise<ComputerUseStatus> => {
      if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Install Cua Driver from Settings → Computer use in a Mousse window on this computer.')
      const { driver, setup } = await bound(binding)
      const running = driver.isInstalling()
      const work = driver.install()
      // Every open card shows the install, in every window, and reads the driver again once it ends.
      if (!running) {
        setup.installChanged()
        void work.then(() => setup.installChanged(), () => setup.installChanged())
      }
      return await work
    }
  })
  domains.register({
    method: 'computerUse.setupRequest.get',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'threadId'])
      return { threadId: id(raw.threadId, 'threadId') }
    },
    handle: async (_context, params, binding): Promise<{ request: ComputerUseSetupRequestView | null }> => ({ request: (await (await bound(binding)).setup.get(params.threadId)) ?? null })
  })
  domains.register({
    method: 'computerUse.setupRequest.dismiss',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'threadId', 'requestId'])
      return { threadId: id(raw.threadId, 'threadId'), requestId: id(raw.requestId, 'requestId') }
    },
    handle: async (context: HandlerContext, params, binding): Promise<{ dismissed: boolean }> => {
      // Not now is a person's answer, from a window of this computer.
      if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Answer it in a Mousse window on this computer.')
      return { dismissed: (await bound(binding)).setup.dismiss(params.threadId, params.requestId) }
    }
  })
}

import { isSourceControlProvider, type SourceControlProviderStatus, type SourceControlStatus, type SourceRepositoryList } from '../../shared/sourceControl'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import { userAction } from '../git/gitPolicy'
import type { GitHubAccount } from '../git/GitHubAccount'

const provider = (value: unknown) => {
  if (!isSourceControlProvider(value)) throw new DomainRpcError('invalid_params', 'provider must be github')
  return value
}

/** Connect and Sign out install software and change the computer's sign-in: a person at a window of this computer asks for them. */
function requireWindow(context: HandlerContext, what: string): void {
  if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', `${what} from Settings → Source control in a Mousse window on this computer.`)
}

/**
 * Settings → Source control and New project's Clone: `sourceControl.status` reads the code hosts this computer is
 * signed in to; `.connect` installs a host's program when it is missing and starts its sign-in, whose one-time code
 * `.status` then carries; `.cancel` stops that; `.signOut` signs out; `.repositories` lists the account's repositories.
 * The account is the computer's, shared by every profile.
 */
export function registerSourceControlMethods(domains: DomainHandlerRegistry, github: () => GitHubAccount): void {
  const all = async (refresh: boolean): Promise<SourceControlStatus> => ({ providers: [await github().status(refresh)] })
  domains.register({
    method: 'sourceControl.status',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'refresh'])
      return { refresh: raw.refresh === true }
    },
    handle: async (_context, params): Promise<SourceControlStatus> => await all(params.refresh)
  })
  domains.register({
    method: 'sourceControl.connect',
    scope: 'profile',
    validate: (params) => ({ provider: provider(domainObject(params ?? {}, ['profileId', 'provider']).provider) }),
    handle: async (context: HandlerContext): Promise<SourceControlProviderStatus> => {
      requireWindow(context, 'Connect GitHub')
      return await github().connect(userAction('button', 'Connect GitHub'))
    }
  })
  domains.register({
    method: 'sourceControl.cancel',
    scope: 'profile',
    validate: (params) => ({ provider: provider(domainObject(params ?? {}, ['profileId', 'provider']).provider) }),
    handle: async (context: HandlerContext): Promise<SourceControlProviderStatus> => {
      requireWindow(context, 'Cancel connecting GitHub')
      return await github().cancel()
    }
  })
  domains.register({
    method: 'sourceControl.signOut',
    scope: 'profile',
    validate: (params) => ({ provider: provider(domainObject(params ?? {}, ['profileId', 'provider']).provider) }),
    handle: async (context: HandlerContext): Promise<SourceControlProviderStatus> => {
      requireWindow(context, 'Sign out of GitHub')
      return await github().signOut(userAction('button', 'Sign out of GitHub'))
    }
  })
  domains.register({
    method: 'sourceControl.repositories',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'provider', 'refresh'])
      return { provider: provider(raw.provider), refresh: raw.refresh === true }
    },
    handle: async (_context, params): Promise<SourceRepositoryList> => await github().listRepositories(params.refresh)
  })
}

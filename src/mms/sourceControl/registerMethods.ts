import { isSourceControlProvider, type SourceControlProviderStatus, type SourceControlStatus, type SourceRepositoryList } from '../../shared/sourceControl'
import { DomainRpcError, domainObject, type DomainHandlerRegistry } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import { userAction, type UserAction } from '../git/gitPolicy'
import type { GitHubAccount } from '../git/GitHubAccount'
import { cloneHere, validBranch, type CloneHereResult } from './cloneHere'
import { browseFolders, type FolderBrowseResult } from '../files/folderBrowse'
import { projectSource, type ProjectSource } from './projectSource'

const provider = (value: unknown) => {
  if (!isSourceControlProvider(value)) throw new DomainRpcError('invalid_params', 'provider must be github')
  return value
}

/** Sign out changes the computer's sign-in: a person at a window of this computer asks for it. */
function requireWindow(context: HandlerContext, what: string): void {
  if (context.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', `${what} from Settings → Source control in a Mousse window on this computer.`)
}

/**
 * Connect installs software and signs the computer in: a person at a window of this computer, or at a window of another
 * of their computers that this one lets work here with terminal access (checked where routed calls arrive).
 */
function requirePerson(context: HandlerContext, what: string): UserAction {
  const type = context.connection?.clientType
  if (type === 'gui') return userAction('button', what)
  if (type === 'bridge' && context.connection?.bridgeCaller) return userAction('device', what)
  throw new DomainRpcError('forbidden', `${what} from Settings → Source control in a Mousse window.`)
}

/** Who started each account's Connect in progress: a window here (`here`), or another computer by its node. */
const starters = new WeakMap<GitHubAccount, { operationId: string; caller: string }>()

/** The caller as `starters` names it; anything that is neither a window here nor another computer is `other`. */
function callerOf(context: HandlerContext): string {
  const connection = context.connection
  if (connection?.clientType === 'gui') return 'here'
  if (connection?.clientType === 'bridge' && connection.bridgeCaller) return `node:${connection.bridgeCaller.node}`
  return 'other'
}

/**
 * A status as this caller may see it. The one-time code signs this computer in to whichever GitHub account enters it,
 * so only a window here and the computer that started the Connect get it (and its address); others see the phase.
 */
function forCaller(account: GitHubAccount, context: HandlerContext, status: SourceControlProviderStatus): SourceControlProviderStatus {
  const operation = status.operation
  if (!operation?.code && !operation?.url) return status
  const caller = callerOf(context)
  const starter = starters.get(account)
  if (caller === 'here' || (starter?.operationId === operation.id && starter.caller === caller)) return status
  const { code: _code, url: _url, ...shown } = operation
  return { ...status, operation: shown }
}

const absolutePath = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new DomainRpcError('invalid_params', `${what} is required`)
  return value
}

/**
 * Settings → Source control and New project's Clone: `sourceControl.status` reads the code hosts this computer is
 * signed in to; `.connect` installs a host's program when it is missing and starts its sign-in, whose one-time code
 * `.status` then carries; `.cancel` stops that; `.signOut` signs out; `.repositories` lists the account's repositories.
 * The account is the computer's, shared by every profile.
 */
export function registerSourceControlMethods(domains: DomainHandlerRegistry, github: () => GitHubAccount): void {
  const all = async (context: HandlerContext, refresh: boolean): Promise<SourceControlStatus> => ({
    providers: [forCaller(github(), context, await github().status(refresh))]
  })
  domains.register({
    method: 'sourceControl.status',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'refresh'])
      return { refresh: raw.refresh === true }
    },
    handle: async (context, params): Promise<SourceControlStatus> => await all(context, params.refresh)
  })
  domains.register({
    method: 'sourceControl.connect',
    scope: 'profile',
    validate: (params) => ({ provider: provider(domainObject(params ?? {}, ['profileId', 'provider']).provider) }),
    handle: async (context: HandlerContext): Promise<SourceControlProviderStatus> => {
      const account = github()
      const status = await account.connect(requirePerson(context, 'Connect GitHub'))
      // The caller that started this Connect sees its one-time code; one that joins it later does not.
      const operationId = status.operation?.id
      if (operationId && starters.get(account)?.operationId !== operationId) starters.set(account, { operationId, caller: callerOf(context) })
      return forCaller(account, context, status)
    }
  })
  domains.register({
    method: 'sourceControl.cancel',
    scope: 'profile',
    validate: (params) => ({ provider: provider(domainObject(params ?? {}, ['profileId', 'provider']).provider) }),
    handle: async (context: HandlerContext): Promise<SourceControlProviderStatus> => {
      requirePerson(context, 'Cancel connecting GitHub')
      return forCaller(github(), context, await github().cancel())
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
  domains.register({
    method: 'sourceControl.clone',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'provider', 'repository', 'path', 'branch'])
      const repository = raw.repository
      if (typeof repository !== 'string' || !repository || repository.length > 512) throw new DomainRpcError('invalid_params', 'repository is required')
      const branch = validBranch(raw.branch)
      return { provider: provider(raw.provider), repository, path: absolutePath(raw.path, 'path'), ...(branch ? { branch } : {}) }
    },
    handle: async (context: HandlerContext, params): Promise<CloneHereResult> => {
      const userRequested = requirePerson(context, 'Clone repository')
      const mms = context.mms
      const result = await cloneHere(params, {
        clone: (input, action) => mms.gitService.github.cloneRepository(input, action),
        openProject: (path) => mms.projects.openProject(path),
        homes: [mms.getProfileHomeDir(), mms.getHomeDir()]
      }, userRequested)
      context.emitEvent?.('projects.updated', { projects: mms.projects.listProjects() })
      return result
    }
  })
  // A project of this computer, to add to another one: its GitHub repository and branch, which a clone there takes.
  domains.register({
    method: 'sourceControl.projectSource',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'projectId'])
      if (typeof raw.projectId !== 'string' || !raw.projectId) throw new DomainRpcError('invalid_params', 'projectId is required')
      return { projectId: raw.projectId }
    },
    handle: async (context: HandlerContext, params): Promise<ProjectSource> => {
      const project = context.mms.projects.getProject(params.projectId)
      if (!project) throw new DomainRpcError('not_found', 'That project is not on this computer.')
      return await projectSource(project.path)
    }
  })
  // Where a clone from another computer goes: the folders of this computer, by name, to pick one by browsing.
  domains.register({
    method: 'folders.browse',
    scope: 'profile',
    validate: (params) => {
      const raw = domainObject(params ?? {}, ['profileId', 'path'])
      return { path: raw.path === undefined ? undefined : absolutePath(raw.path, 'path') }
    },
    handle: async (context: HandlerContext, params): Promise<FolderBrowseResult> =>
      await browseFolders(params.path, { homes: [context.mms.getProfileHomeDir(), context.mms.getHomeDir()] })
  })
}
import {
  BROWSER_SETUP_CAPABILITY,
  BROWSER_SETUP_METHODS,
  BROWSER_SETUP_OPERATION_ID_PATTERN,
  type BrowserSetupCancelResult,
  type BrowserSetupInstallResult,
  type BrowserSetupStatus
} from '../../shared/browser/setup'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import type { HandlerContext } from '../protocol/handlers'
import {
  BrowserSetupAdmissionError,
  BrowserSetupError,
  type BrowserSetupService
} from './BrowserSetupService'

const SETUP_FIELDS: Record<(typeof BROWSER_SETUP_METHODS)[number], readonly string[]> = {
  'browser.setup.status': [],
  'browser.setup.install': [],
  'browser.setup.cancel': ['operationId']
}

const SETUP_CLIENTS = new Set(['gui', 'cli'])

export interface BrowserSetupDomainRegistration {
  dispose(): void
}

function asOperationId(value: unknown): string {
  if (typeof value !== 'string' || !BROWSER_SETUP_OPERATION_ID_PATTERN.test(value)) {
    throw new DomainRpcError('invalid_params', 'Invalid operationId')
  }
  return value
}

function requireSetupCaller(context: HandlerContext): void {
  const connection = context.connection
  if (!connection?.id) {
    throw new DomainRpcError('unauthenticated', 'Browser setup requires an authenticated GUI or CLI connection')
  }
  if (!SETUP_CLIENTS.has(connection.clientType ?? '')) {
    throw new DomainRpcError(
      'capability_required',
      'Browser setup requires an authenticated GUI or CLI connection'
    )
  }
}

function rpc(error: unknown): never {
  if (error instanceof DomainRpcError) throw error
  if (error instanceof BrowserSetupAdmissionError || error instanceof BrowserSetupError) {
    throw new DomainRpcError(error.code, error.message)
  }
  throw error
}

/**
 * Bind once before server seal. Installation scope; one daemon-owned setup
 * service. Connection close must not cancel an in-flight install.
 * Root adds BROWSER_SETUP_METHODS to the GUI allowlist and
 * `browser.setup.` to isInstallationMethod.
 */
export function registerBrowserSetupMethods(
  domains: DomainHandlerRegistry,
  setup: BrowserSetupService
): BrowserSetupDomainRegistration {
  let disposed = false

  for (const method of BROWSER_SETUP_METHODS) {
    domains.register({
      method,
      scope: 'installation',
      capability: BROWSER_SETUP_CAPABILITY,
      requiredCapabilities: [BROWSER_SETUP_CAPABILITY],
      validate: (value) => domainObject(value ?? {}, SETUP_FIELDS[method]),
      async handle(context, params) {
        try {
          if (disposed) throw new DomainRpcError('service_unavailable', 'Browser setup is shutting down')
          requireSetupCaller(context)
          if (method === 'browser.setup.status') return (await setup.status()) satisfies BrowserSetupStatus
          if (method === 'browser.setup.install') {
            return (await setup.install()) satisfies BrowserSetupInstallResult
          }
          return (await setup.cancel(asOperationId(params.operationId))) satisfies BrowserSetupCancelResult
        } catch (error) {
          rpc(error)
        }
      }
    })
  }

  return {
    dispose() {
      disposed = true
    }
  }
}

import type { AdapterRegistry } from '../AdapterRegistry'
import { CodexAdapter, type CodexClient } from './CodexAdapter'

export { CODEX_CAPABILITIES, CodexAdapter, type CodexClient } from './CodexAdapter'
export {
  CODEX_PROVIDER_ID,
  CodexProviderService,
  createCodexProviderService,
  type CodexServiceDependencies,
  type CodexStatus
} from '../../../providers/codex/CodexProviderService'

/**
 * Registers the Codex adapter. `service` is read on every turn, so the profile can install (or
 * replace) its `CodexProviderService` after the registry is built, as it does for Claude.
 */
export function registerCodexAdapter(registry: AdapterRegistry, service: () => CodexClient | null): CodexAdapter {
  const adapter = new CodexAdapter(service)
  registry.register(adapter)
  return adapter
}

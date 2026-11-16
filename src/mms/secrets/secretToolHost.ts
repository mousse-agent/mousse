import type { SecretToolHost } from '../run/mcp/appTools/secrets'
import type { SecretRequests } from './SecretRequests'
import type { SecretVault } from './SecretVault'
import { runWithSecrets } from './runWithSecrets'
import type { BotSecretContainment } from './botSecretCommand'

/**
 * What `secret_request` and `secret_run` reach (#595): the profile's open requests and its vault. A command gets the
 * named secrets only when the thread may use them, and its output is masked with every secret the thread may use.
 */
export function createSecretToolHost(input: { vault: SecretVault; requests: SecretRequests; scratchRoot: string; baseEnv?: NodeJS.ProcessEnv; containment?: BotSecretContainment }): SecretToolHost {
  const { vault, requests } = input
  return {
    request: (threadId, request, signal) => requests.request(threadId, request, { signal }),
    endThread: (threadId) => requests.endThread(threadId),
    usableIn: (name, threadId) => vault.usableIn(name, threadId),
    masker: (threadId) => vault.maskerFor(threadId),
    run: async (run) => {
      const secrets = run.secrets.map((entry) => {
        if (!vault.usableIn(entry.name, run.threadId)) throw new Error(`This thread has no secret named ${entry.name}.`)
        const value = vault.value(entry.name)
        if (value === undefined) throw new Error(`The secret ${entry.name} is gone (it expired or was removed).`)
        return { ...entry, value }
      })
      for (const entry of secrets) vault.markUsed(entry.name)
      return runWithSecrets({
        command: run.command,
        cwd: run.cwd,
        secrets,
        mask: vault.maskerFor(run.threadId) ?? ((text) => text),
        scratchRoot: input.scratchRoot,
        timeoutMs: run.timeoutMs,
        signal: run.signal,
        ...(input.baseEnv ? { baseEnv: input.baseEnv } : {}),
        // A personal bot's command: held to its folders and its filtered environment, or refused.
        ...(run.contain ? { contain: { ...run.contain, ...(input.containment ? { containment: input.containment } : {}) } } : {})
      })
    }
  }
}

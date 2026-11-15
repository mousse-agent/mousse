import type { PlatformRequestApi } from '../../shared/platform'
import type { SecretEntryView, SecretKeep, SecretRequestView } from '../../shared/secretRequests'

/** The secret methods (#595) a window calls. Replies never hold a value. */
export interface SecretsClient {
  requests(threadId: string): Promise<SecretRequestView[]>
  /** Save securely: the value is sent once, to the daemon of this computer, and the name it was kept under comes back. */
  answer(threadId: string, requestId: string, value: string, keep: SecretKeep): Promise<{ name: string }>
  useSaved(threadId: string, requestId: string): Promise<{ name: string }>
  decline(threadId: string, requestId: string): Promise<void>
  list(): Promise<SecretEntryView[]>
  remove(name: string): Promise<void>
}

export function createSecretsClient(transport: PlatformRequestApi): SecretsClient {
  return {
    requests: async (threadId) => (await transport.request<{ requests: SecretRequestView[] }>('secrets.requests.list', { threadId })).requests,
    answer: (threadId, requestId, value, keep) => transport.request<{ name: string }>('secrets.requests.answer', { threadId, requestId, value, keep }),
    useSaved: (threadId, requestId) => transport.request<{ name: string }>('secrets.requests.useSaved', { threadId, requestId }),
    decline: async (threadId, requestId) => { await transport.request('secrets.requests.decline', { threadId, requestId }) },
    list: async () => (await transport.request<{ secrets: SecretEntryView[] }>('secrets.list', {})).secrets,
    remove: async (name) => { await transport.request('secrets.delete', { name }) }
  }
}

/**
 * The Cursor SDK calls Mousse makes, written against the pinned `@cursor/sdk` and type-checked by
 * `cursorSdkSurface.test.ts`. A version bump that changes any of them fails that test.
 */
import {
  Agent,
  Cursor,
  InMemoryCredentialStore,
  JsonlLocalAgentStore,
  type AgentOptions,
  type CursorRequestOptions,
  type LocalAgentOptions,
  type LocalSendOptions,
  type SdkLoginOptions,
  type SendOptions
} from '@cursor/sdk'

declare const signal: AbortSignal
const store = new JsonlLocalAgentStore('/state/cursor-store')

// Per-call credentials, the instance's store, and the SDK's retries off on create and resume.
const local: LocalAgentOptions = { cwd: '/work', store, settingSources: ['project', 'user', 'team', 'mdm', 'plugins'], autoReview: true, enableAgentRetries: false }
export const create = () => Agent.create({ apiKey: 'key', model: { id: 'default' }, mode: 'agent', local })
export const resume = () => Agent.resume('agent-1', { apiKey: 'key', model: { id: 'default' }, mode: 'plan', local })
export const send = async () =>
  (await create()).send(
    { text: 'hi', images: [{ data: 'AAAA', mimeType: 'image/png' }] },
    { model: { id: 'default' }, mode: 'plan', mcpServers: { mousse: { type: 'http', url: 'http://127.0.0.1/mcp', headers: { Authorization: 'Bearer t' } } }, onDelta: ({ update }) => void update.type }
  )
export const runs = () => Agent.listRuns('agent-1', { runtime: 'local', cwd: '/work', store, limit: 5 })
export const cancelRun = () => Agent.cancelRun('run-1', { runtime: 'local', cwd: '/work', store })
export const messages = () => Agent.messages.list('agent-1', { runtime: 'local', cwd: '/work', store })
export const models = () => Cursor.models.list({ apiKey: 'key' } satisfies CursorRequestOptions)
export const me = () => Cursor.me({ apiKey: 'key' })
export const login = () =>
  Cursor.auth.login({ openBrowser: false, onLoginUrl: (_url: string) => {}, store: new InMemoryCredentialStore(), signal, apiKeyName: 'Mousse' } satisfies SdkLoginOptions)
export const loginResult = async () => {
  const { apiKey, apiKeyExpiresAtMs, email } = await login()
  return { apiKey: apiKey satisfies string, apiKeyExpiresAtMs: apiKeyExpiresAtMs satisfies number, email: email satisfies string | undefined }
}

type Has<T, K extends PropertyKey> = K extends keyof T ? true : false
// Sends have no retry flag of their own: they inherit the agent's.
export const sendHasNoRetryFlag: Has<LocalSendOptions, 'enableAgentRetries'> = false
// No approval callback anywhere: Cursor approves its tools itself (the instance is `uncontrolled`).
type ApprovalKeys = 'canUseTool' | 'onToolApproval' | 'onPermissionRequest' | 'onApproval' | 'approvalCallback' | 'permissionPrompt'
export const noAgentApproval: [Extract<keyof AgentOptions, ApprovalKeys>] extends [never] ? true : false = true
export const noLocalApproval: [Extract<keyof LocalAgentOptions, ApprovalKeys>] extends [never] ? true : false = true
export const noSendApproval: [Extract<keyof SendOptions, ApprovalKeys>] extends [never] ? true : false = true

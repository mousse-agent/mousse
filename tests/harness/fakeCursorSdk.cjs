// A stand-in for `@cursor/sdk` that the real Cursor host loads in tests
// (`MOUSSE_CURSOR_SDK_MODULE`). It records every call with the options it got, and scripts runs
// by the message text. Never contacts Cursor.
const { appendFileSync } = require('node:fs')

function log(entry) {
  if (process.env.MOUSSE_FAKE_CURSOR_LOG) appendFileSync(process.env.MOUSSE_FAKE_CURSOR_LOG, `${JSON.stringify(entry)}\n`)
}

class JsonlLocalAgentStore {
  constructor(dir) {
    this.kind = 'jsonl'
    this.dir = dir
    this.agents = { delete: async (input) => log({ call: 'store.agents.delete', storeDir: dir, filter: input.filter }) }
    this.runs = { delete: async (input) => log({ call: 'store.runs.delete', storeDir: dir, filter: input.filter }) }
  }
}

class InMemoryCredentialStore {
  constructor() {
    this.kind = 'memory'
  }
}

class FileCredentialStore {
  constructor() {
    log({ call: 'FileCredentialStore' })
  }
}

function described(options) {
  const local = options.local
  return {
    apiKey: options.apiKey ?? null,
    model: options.model,
    mode: options.mode,
    local: local && {
      store: local.store && local.store.kind,
      storeDir: local.store && local.store.dir,
      settingSources: local.settingSources,
      enableAgentRetries: local.enableAgentRetries,
      autoReview: local.autoReview,
      customTools: 'customTools' in local
    }
  }
}

let agents = 0
let runs = 0
let handles = 0

function makeAgent(agentId) {
  const handle = ++handles
  return {
    agentId,
    model: undefined,
    async send(message, options) {
      log({ call: 'send', agentId, text: message.text, model: options.model, mode: options.mode, keys: Object.keys(options).sort() })
      const id = `run-${++runs}`
      const delta = (update) => options.onDelta({ update })
      let finish
      const finished = new Promise((resolve) => {
        finish = resolve
      })
      const later = (fn) => setTimeout(fn, 5)
      if (message.text === 'hello') {
        // An update before `send` returns: the host must deliver it after its reply.
        await delta({ type: 'text-delta', text: 'Hel' })
        later(async () => {
          await delta({ type: 'thinking-delta', text: 'Plan' })
          await delta({ type: 'tool-call-started', callId: 'c1', toolCall: { type: 'shell', args: { command: 'npm test' } } })
          await delta({ type: 'tool-call-completed', callId: 'c1', toolCall: { type: 'shell', args: { command: 'npm test' } } })
          await delta({ type: 'text-delta', text: 'lo' })
          finish({ id, status: 'finished', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } })
        })
      } else if (message.text === 'transport') {
        later(async () => {
          await delta({ type: 'text-delta', text: 'Error: ConnectError: [unavailable] connection reset' })
          finish({ id, status: 'finished' })
        })
      } else if (message.text === 'closed-stream') {
        later(async () => {
          const error = new Error('closed')
          error.name = 'WriteIterableClosedError'
          Promise.reject(error)
          await delta({ type: 'text-delta', text: 'still here' })
          finish({ id, status: 'finished' })
        })
      } else if (message.text === 'revoked' || message.text === 'expired') {
        // `wait()` resolves a failed run: the SDK reduces its AuthenticationError to a RunError code.
        later(() => finish({ id, status: 'error', error: { message: 'Invalid API key', code: message.text === 'revoked' ? 'unauthenticated' : 'AUTH_TOKEN_EXPIRED' } }))
      } else if (message.text === 'crash') {
        later(() => {
          Promise.reject(new Error('an SDK bug nobody awaited'))
        })
      } else {
        later(async () => {
          await delta({ type: 'text-delta', text: 'ok' })
          finish({ id, status: 'finished' })
        })
      }
      return {
        id,
        agentId,
        wait: () => finished,
        cancel: async () => {
          log({ call: 'cancel', runId: id })
          finish({ id, status: 'cancelled' })
        }
      }
    },
    close() {
      log({ call: 'close', agentId, handle })
    }
  }
}

const Agent = {
  async create(options) {
    log({ call: 'create', options: described(options), ambientKey: process.env.CURSOR_API_KEY ?? null })
    return makeAgent(`agent-${++agents}`)
  },
  async resume(agentId, options) {
    log({ call: 'resume', agentId, options: described(options) })
    return makeAgent(agentId)
  },
  async listRuns(agentId, options) {
    log({ call: 'listRuns', agentId, store: options.store && options.store.kind })
    return { items: [] }
  },
  async cancelRun(runId, options) {
    log({ call: 'cancelRun', runId, store: options.store && options.store.kind })
  },
  messages: {
    async list(agentId) {
      log({ call: 'messages', agentId })
      return []
    }
  }
}

const Cursor = {
  async me(options) {
    log({ call: 'me', apiKey: options && options.apiKey })
    return { apiKeyName: 'Mousse', userId: 5, createdAt: '2026-10-26T00:00:00Z' }
  },
  models: {
    async list(options) {
      log({ call: 'models', apiKey: options && options.apiKey })
      return [{ id: 'gpt-5', displayName: 'GPT-5' }]
    }
  },
  auth: {
    async login(options) {
      log({ call: 'login', openBrowser: options.openBrowser, store: options.store && options.store.kind, signal: Boolean(options.signal) })
      options.onLoginUrl('https://cursor.com/loginDeepControl?challenge=fake')
      return { apiKey: 'minted-key', apiKeyExpiresAtMs: Date.now() + 1_000_000_000 }
    }
  }
}

module.exports = { Agent, Cursor, JsonlLocalAgentStore, InMemoryCredentialStore, FileCredentialStore }

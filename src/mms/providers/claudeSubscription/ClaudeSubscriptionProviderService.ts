import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ConfiguredProvider,
  ProviderLoginOption,
  ProviderLoginResult,
  ProviderUsage
} from '../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import { AppError } from '../../../shared/errors'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import type { LoginSession } from '../LoginSession'
import {
  ClaudeMetricsCollector,
  ClaudeNativeEditCounter,
  type ClaudeSubscriptionMetrics,
  type ClaudeUsageBaseline
} from './metrics'
import { parseClaudeSubscriptionUsage } from './usage'

export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = 'claude-subscription'
type SavedSession = {
  sessionId: string
  cwd: string
  historyKey?: string
  usageBaseline?: ClaudeUsageBaseline
}
type Settings = {
  signedIn?: boolean
  binaryPath?: string
  models?: LlmModelOption[]
  sessions?: Record<string, SavedSession>
}
export type ClaudeSubscriptionChatInput = {
  threadId: string
  cwd: string
  model: string
  prompt: string
  appletInstructions?: string
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mode?: 'plan' | 'default'
  onText: (text: string) => void
  onThinking?: (text: string) => void
  onMetrics?: (report: ClaudeSubscriptionMetrics) => void
  onLineEdits?: (lines: number) => void
  drainSteer?: () => string | undefined
  onSteer?: (text: string) => void
  onTool?: (event: {
    phase: 'start' | 'complete'
    callId: string
    title: string
    toolName?: string
  }) => void
}
type Dependencies = {
  query?: (input: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Query
  runAuth?: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ) => Promise<string>
  startLogin?: (binary: string, env: NodeJS.ProcessEnv) => ChildProcess
}

/** Each profile authenticates through the unmodified CLI. Mousse never reads its token files. */
export function claudeSubscriptionEnvironment(
  configDir: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDE_CODE_API_KEY_HELPER|CLAUDE_CODE_CUSTOM_MODEL|AWS_|AMAZON_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|VERTEX_|BEDROCK_)/.test(
        key
      ) ||
      ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR'].includes(key)
    )
      delete env[key]
  }
  env.CLAUDE_CONFIG_DIR = configDir
  return env
}

function binaryOnPath(): string | undefined {
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude']
  for (const directory of [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin')
  ]) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* continue */
      }
    }
  }
  return undefined
}
function runAuth(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolveResult, reject) =>
    execFile(
      binary,
      args,
      { env, signal, timeout: 15_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              signal?.aborted
                ? 'Claude sign-in cancelled'
                : 'Claude Code authentication command failed. Install or update the official Claude Code CLI.'
            )
          )
        else resolveResult(stdout)
      }
    )
  )
}
const historyKey = (history: string) => createHash('sha256').update(history).digest('hex')
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

export class ClaudeSubscriptionProviderService {
  private readonly settingsPath: string
  readonly configDir: string
  private settings: Settings
  private stopped = false
  private readonly queries = new Map<string, Query>()
  private readonly readyToCommit = new Set<string>()
  private readonly logins = new Set<ChildProcess>()
  private readonly loginSessions = new Set<LoginSession>()
  private readonly controllers = new Set<AbortController>()
  private readonly activeThreads = new Set<string>()

  constructor(
    private readonly profileHome: string,
    private readonly questions: UserQuestionService,
    private readonly dependencies: Dependencies = {}
  ) {
    this.configDir = join(
      profileHome,
      'providers',
      CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      'claude-config'
    )
    this.settingsPath = join(
      profileHome,
      'providers',
      CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      'settings.json'
    )
    try {
      this.settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Settings
    } catch {
      this.settings = {}
    }
  }
  standaloneWorkspace(threadId: string): string {
    const directory = join(this.profileHome, 'providers', CLAUDE_SUBSCRIPTION_PROVIDER_ID, 'workspaces', historyKey(threadId))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  private save(): void {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(this.settingsPath, this.settings)
  }
  private binary(): string | undefined {
    const selected = this.settings.binaryPath
    if (!selected) return binaryOnPath()
    try {
      if (!isAbsolute(selected)) return undefined
      accessSync(selected, constants.X_OK)
      return selected
    } catch {
      return undefined
    }
  }
  configured(): boolean {
    return !this.stopped && Boolean(this.settings.signedIn && this.binary())
  }
  configuredProvider(): ConfiguredProvider | undefined {
    return this.configured()
      ? {
          id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
          label: 'Claude Subscription',
          authType: 'oauth',
          source: 'Official Claude Code · Claude-managed billing'
        }
      : undefined
  }
  loginOption(): ProviderLoginOption {
    return {
      id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      label: 'Claude Subscription',
      authType: 'oauth',
      configured: this.configured(),
      guidedLogin: true,
      description: 'Official Claude Code · personal account'
    }
  }
  llmProvider(): LlmProviderOption | undefined {
    return this.configured() && this.settings.models?.length
      ? {
          id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
          label: 'Claude Subscription',
          models: this.settings.models
        }
      : undefined
  }
  private async authenticated(signal?: AbortSignal): Promise<boolean> {
    const binary = this.binary()
    if (!binary) return false
    try {
      const output = await (this.dependencies.runAuth ?? runAuth)(
        binary,
        ['auth', 'status'],
        claudeSubscriptionEnvironment(this.configDir),
        signal
      )
      const status = JSON.parse(output) as { loggedIn?: boolean; authMethod?: string }
      return status.loggedIn === true && status.authMethod === 'claude.ai'
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }
  async login(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    let child: ChildProcess | undefined
    const cancel = () => child?.kill()
    this.loginSessions.add(session)
    session.abort.signal.addEventListener('abort', cancel, { once: true })
    try {
      if (this.stopped) throw new Error('Claude provider is stopped')
      const interaction = session.createAuthCallbacks()
      if (!this.binary()) {
        const binary = await interaction.prompt({
          type: 'text',
          message: 'Install the official Claude Code CLI, then enter its absolute executable path',
          placeholder: '/home/me/.local/bin/claude'
        })
        if (!isAbsolute(binary)) throw new Error('Claude Code binary path must be absolute')
        this.settings.binaryPath = binary
        if (!this.binary()) throw new Error('Claude Code executable is unavailable')
      }
      this.save()
      if (!(await this.authenticated(session.abort.signal))) {
        const binary = this.binary()!
        child = (
          this.dependencies.startLogin ??
          ((path, env) => spawn(path, ['auth', 'login', '--claudeai'], { env, stdio: 'ignore' }))
        )(binary, claudeSubscriptionEnvironment(this.configDir))
        this.logins.add(child)
        child.on('error', () => {
          /* terminal fallback below */
        })
        const command =
          process.platform === 'win32'
            ? `$env:CLAUDE_CONFIG_DIR = '${this.configDir.replaceAll("'", "''")}'; & '${binary.replaceAll("'", "''")}' auth login --claudeai`
            : `CLAUDE_CONFIG_DIR=${quote(this.configDir)} ${quote(binary)} auth login --claudeai`
        for (;;) {
          const answer = await interaction.prompt({
            type: 'select',
            message: `Claude Code opens its own browser sign-in. Complete it, then check sign-in. If no browser opens, run this command in a terminal:\n${command}\nMousse does not collect Claude credentials. Claude controls subscription and Agent SDK billing.`,
            options: [
              { id: 'check', label: 'Check sign-in' },
              { id: 'cancel', label: 'Cancel' }
            ]
          })
          if (answer !== 'check') throw new Error('Claude sign-in cancelled')
          if (await this.authenticated(session.abort.signal)) break
          interaction.notify({
            type: 'progress',
            message:
              'No Claude subscription sign-in found in this profile. Complete Claude Code sign-in first.'
          })
        }
      }
      session.abort.signal.throwIfAborted()
      this.settings.signedIn = true
      this.save()
      try {
        await this.refreshModels(cwd, session.abort.signal)
      } catch {
        session.abort.signal.throwIfAborted()
        if (this.stopped) throw new Error('Claude provider is stopped')
        if (!this.settings.models?.length)
          this.settings.models = ['sonnet', 'opus', 'haiku'].map((id) => ({
            id,
            label: `Claude ${id[0].toUpperCase()}${id.slice(1)}`
          }))
        this.save()
        interaction.notify({
          type: 'progress',
          message:
            'Signed in. Model discovery is unavailable; Claude Code model aliases are available.'
        })
      }
      session.abort.signal.throwIfAborted()
      if (this.stopped) throw new Error('Claude provider is stopped')
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      return {
        success: false,
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      child?.kill()
      if (child) this.logins.delete(child)
      this.loginSessions.delete(session)
      session.abort.signal.removeEventListener('abort', cancel)
    }
  }
  private async createQuery(
    prompt: string | AsyncIterable<SDKUserMessage>,
    options: Options
  ): Promise<Query> {
    if (this.stopped) throw new Error('Claude provider is stopped')
    if (this.dependencies.query) return this.dependencies.query({ prompt, options })
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    options.abortController?.signal.throwIfAborted()
    if (this.stopped) throw new Error('Claude provider is stopped')
    return sdk.query({ prompt, options })
  }
  private options(cwd: string, controller: AbortController): Options {
    return {
      cwd,
      pathToClaudeCodeExecutable: this.binary(),
      env: claudeSubscriptionEnvironment(this.configDir),
      abortController: controller,
      permissionMode: 'default',
      permissionPrompts: 'host',
      settingSources: [],
      mcpServers: {},
      extraArgs: { 'strict-mcp-config': null },
      includePartialMessages: true
    }
  }
  async refreshModels(cwd: string, signal?: AbortSignal): Promise<void> {
    if (!this.configured()) return
    const controller = new AbortController()
    this.controllers.add(controller)
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, 15_000)
    let query: Query | undefined
    try {
      signal?.throwIfAborted()
      // Streaming input stays empty: initialize/discover only, never submit a billable prompt.
      const idle = async function* (): AsyncGenerator<SDKUserMessage> {
        if (controller.signal.aborted) return
        await new Promise<void>((resolveIdle) =>
          controller.signal.addEventListener('abort', () => resolveIdle(), { once: true })
        )
      }
      query = await this.createQuery(idle(), {
        ...this.options(cwd, controller),
        tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'Model discovery cannot run tools' })
      })
      const models = await query.supportedModels()
      controller.signal.throwIfAborted()
      if (models.length) {
        this.settings.models = models.map((model) => ({
          id: model.value,
          label: model.displayName,
          efforts: model.supportedEffortLevels
        }))
        this.save()
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
      query?.close()
      this.controllers.delete(controller)
      signal?.removeEventListener('abort', cancel)
    }
  }
  async getUsage(cwd: string, signal?: AbortSignal): Promise<ProviderUsage> {
    const unavailable = parseClaudeSubscriptionUsage(undefined)
    if (!this.configured()) return unavailable
    const controller = new AbortController()
    this.controllers.add(controller)
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    let query: Query | undefined
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 15_000)
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error(timedOut ? 'Usage check timed out' : 'Usage check canceled'))
      controller.signal.addEventListener('abort', fail, { once: true })
      if (controller.signal.aborted) fail()
    })
    // Pre-aborted callers may leave before reaching either race.
    void aborted.catch(() => {})
    try {
      controller.signal.throwIfAborted()
      const idle = async function* (): AsyncGenerator<SDKUserMessage> {
        if (controller.signal.aborted) return
        await new Promise<void>((resolveIdle) =>
          controller.signal.addEventListener('abort', () => resolveIdle(), { once: true })
        )
      }
      const pending = this.createQuery(idle(), {
        ...this.options(cwd, controller),
        tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'Usage checks cannot run tools' })
      }).then((created) => {
        // Initialization may ignore abort: dispose a late query after this request has settled.
        if (controller.signal.aborted) created.close()
        else query = created
        return created
      })
      query = await Promise.race([pending, aborted])
      controller.signal.throwIfAborted()
      const usageQuery = query as Query & {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (
          opts: { skipBehaviors: boolean }
        ) => Promise<unknown>
      }
      const readUsage = usageQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof readUsage !== 'function') return unavailable
      const response = await Promise.race([
        readUsage.call(query, { skipBehaviors: true }),
        aborted
      ])
      controller.signal.throwIfAborted()
      return parseClaudeSubscriptionUsage(response)
    } catch {
      return {
        ...unavailable,
        status: 'error',
        // SDK errors may contain URLs or account details; do not forward their raw text.
        message: timedOut
          ? 'Claude usage check timed out. Try refreshing.'
          : controller.signal.aborted
            ? 'Claude usage check was canceled.'
            : 'Unable to retrieve Claude account usage limits. Try refreshing.'
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
      query?.close()
      this.controllers.delete(controller)
      signal?.removeEventListener('abort', cancel)
    }
  }
  commitConversation(threadId: string, history: string): void {
    if (!this.readyToCommit.delete(threadId)) return
    const saved = this.settings.sessions?.[threadId]
    if (saved) {
      saved.historyKey = historyKey(history)
      this.save()
    }
  }
  async chat(input: ClaudeSubscriptionChatInput): Promise<string> {
    input.signal?.throwIfAborted()
    if (!this.configured()) throw new AppError({ code: 'claude_subscription_not_connected', message: 'Connect Claude Subscription in Settings → Providers first.', errorInfo: { category: 'unavailable', retryable: false } })
    if (this.activeThreads.has(input.threadId))
      throw new Error('A Claude turn is already running for this thread')
    this.activeThreads.add(input.threadId)
    const controller = new AbortController()
    this.controllers.add(controller)
    let query: Query | undefined
    const cancel = () => {
      controller.abort()
      query?.close()
      this.questions.dismissAllForThread(input.threadId)
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    this.readyToCommit.delete(input.threadId)
    const saved = this.settings.sessions?.[input.threadId]
    const resume =
      saved?.cwd === resolve(input.cwd) && saved.historyKey === historyKey(input.history ?? '')
        ? saved.sessionId
        : undefined
    const metrics = new ClaudeMetricsCollector(resume, saved?.usageBaseline)
    const editCounter = new ClaudeNativeEditCounter(input.cwd, input.onLineEdits)
    if (saved) {
      delete saved.historyKey
      this.save()
    }
    let text = '',
      thinking = '',
      success = false,
      sessionId: string | undefined
    const tools = new Map<string, string>()
    const steers: string[] = []
    let steerTimer: ReturnType<typeof setInterval> | undefined
    let interruptRequested = false
    const collectSteer = () => {
      if (controller.signal.aborted) return
      const steer = input.drainSteer?.()?.trim()
      if (!steer) return
      steers.push(steer)
      input.onSteer?.(steer)
      if (query && !interruptRequested) {
        interruptRequested = true
        this.questions.autoRejectPendingForThread(input.threadId)
        void query.interrupt().catch(() => cancel())
      }
    }
    try {
      if (!(await this.authenticated(controller.signal)))
        throw new AppError({ code: 'claude_subscription_sign_in_required', message: 'Claude subscription sign-in expired. Reconnect in Settings → Providers.', errorInfo: { category: 'unavailable', retryable: false } })
      controller.signal.throwIfAborted()
      input.signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      const prompt = (input.appletInstructions ? input.appletInstructions + '\n\nCurrent request:\n' : '') +
        (!resume && input.history
          ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
          : '') + input.prompt
      const content: SDKUserMessage['message']['content'] = [
        { type: 'text', text: prompt || '(image attachment)' }
      ]
      for (const image of input.images ?? []) {
        if (
          !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mimeType) ||
          Buffer.byteLength(image.data, 'base64') > 10 * 1024 * 1024
        )
          throw new Error(`Unsupported Claude image: ${image.name}`)
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType as 'image/png', data: image.data }
        })
      }
      const messages = async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          session_id: resume ?? ''
        }
      }
      const selected = parseThinkingSuffixFromModelId(input.model)
      const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(selected.effort ?? '')
        ? selected.effort as Options['effort'] : undefined
      const options: Options = {
        ...this.options(input.cwd, controller),
        model: selected.baseId,
        effort,
        resume,
        permissionMode: input.mode ?? 'default',
        // Ask hooks ensure ambient rules cannot silently approve writes or shell calls.
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (event) => {
                  if (event.hook_event_name === 'PreToolUse')
                    await editCounter.start(event.tool_use_id, event.tool_name, event.tool_input)
                  return {
                    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' }
                  }
                }
              ]
            }
          ],
          PostToolUse: [
            {
              hooks: [
                async (event) => {
                  if (event.hook_event_name === 'PostToolUse')
                    await editCounter.success(event.tool_use_id, event.tool_response)
                  return {}
                }
              ]
            }
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (event) => {
                  if (event.hook_event_name === 'PostToolUseFailure')
                    editCounter.failure(event.tool_use_id)
                  return {}
                }
              ]
            }
          ]
        },
        canUseTool: async (toolName, args, context) => {
          if (controller.signal.aborted || context.signal.aborted)
            return { behavior: 'deny', message: 'Turn cancelled' }
          if (
            input.mode === 'plan' &&
            !['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'].includes(toolName)
          )
            return {
              behavior: 'deny',
              message: 'This turn is planning only; edits and shell commands are disabled.'
            }
          try {
            if (toolName === 'AskUserQuestion') {
              const native = args.questions as
                | Array<{
                    question: string
                    options?: Array<{ label: string; description?: string }>
                    multiSelect?: boolean
                  }>
                | undefined
              if (
                !Array.isArray(native) ||
                !native.length ||
                native.length > 4 ||
                native.some((item) => typeof item.question !== 'string')
              )
                return { behavior: 'deny', message: 'Invalid Claude question' }
              const answers = await this.questions.requestAnswers(
                native.map((item, index) => ({
                  id: String(index),
                  prompt: item.question,
                  allowMultiple: item.multiSelect,
                  options: (item.options ?? []).map((option) => ({
                    id: option.label,
                    label: option.label,
                    description: option.description
                  }))
                })),
                input.threadId
              )
              if (controller.signal.aborted || context.signal.aborted)
                return { behavior: 'deny', message: 'Turn cancelled' }
              return {
                behavior: 'allow',
                updatedInput: {
                  ...args,
                  answers: Object.fromEntries(
                    native.map((item, index) => [
                      item.question,
                      Array.isArray(answers[String(index)])
                        ? (answers[String(index)] as string[]).join(', ')
                        : answers[String(index)]
                    ])
                  )
                }
              }
            }
            const answer = await this.questions.requestAnswers(
              [
                {
                  id: 'permission',
                  prompt: `Allow Claude Code to use ${toolName}?\n${JSON.stringify(args).slice(0, 4000)}`,
                  options: [
                    { id: 'allow', label: 'Allow once' },
                    { id: 'reject', label: 'Reject' }
                  ]
                }
              ],
              input.threadId
            )
            if (
              controller.signal.aborted ||
              context.signal.aborted ||
              answer.permission !== 'allow'
            )
              return { behavior: 'deny', message: 'Permission rejected' }
            return { behavior: 'allow', updatedInput: args }
          } catch {
            return { behavior: 'deny', message: 'Permission dismissed' }
          }
        }
      }
      let nextPrompt: AsyncIterable<SDKUserMessage> = messages()
      if (input.drainSteer)
        steerTimer = setInterval(() => {
          try {
            collectSteer()
          } catch {
            cancel()
          }
        }, 100)
      for (;;) {
        const turnTextLength = text.length
        query = await this.createQuery(nextPrompt, options)
        this.queries.set(input.threadId, query)
        for await (const message of query) {
          metrics.observe(message)
          controller.signal.throwIfAborted()
          sessionId = message.session_id || sessionId
          if (message.type === 'stream_event') {
            const event = message.event
            if (event.type === 'content_block_delta' && !message.parent_tool_use_id) {
              if (event.delta.type === 'text_delta') {
                text += event.delta.text
                input.onText(text)
              }
              if (event.delta.type === 'thinking_delta') {
                thinking += event.delta.thinking
                input.onThinking?.(thinking)
              }
            }
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
              tools.set(event.content_block.id, event.content_block.name)
              input.onTool?.({
                phase: 'start',
                callId: event.content_block.id,
                title: event.content_block.name,
                toolName: event.content_block.name
              })
            }
          }
          if (message.type === 'user' && Array.isArray(message.message.content))
            for (const block of message.message.content) {
              if (block.type === 'tool_result' && tools.has(block.tool_use_id)) {
                input.onTool?.({
                  phase: 'complete',
                  callId: block.tool_use_id,
                  title: tools.get(block.tool_use_id)!
                })
                tools.delete(block.tool_use_id)
              }
            }
          if (message.type === 'result') {
            if (
              (message.subtype !== 'success' || message.is_error) &&
              !(interruptRequested && steers.length)
            )
              throw new Error(
                'errors' in message ? message.errors.join('\n') : 'Claude Code turn failed'
              )
            if (text.length === turnTextLength && 'result' in message) {
              text += message.result
              input.onText(text)
            }
            success = true
          }
        }
        const completed = query
        query = undefined
        collectSteer()
        completed.close()
        if (!steers.length) break
        controller.signal.throwIfAborted()
        if (!sessionId) throw new Error('Claude steering could not identify the active session')
        options.resume = sessionId
        metrics.beginQuery(sessionId)
        const guidance = steers.splice(0).join('\n')
        nextPrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
          yield {
            type: 'user',
            message: { role: 'user', content: guidance },
            parent_tool_use_id: null,
            session_id: sessionId
          }
        })()
        interruptRequested = false
        success = false
        if (text) text += '\n\n'
      }
      input.signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      if (!success || !sessionId) throw new Error('Claude Code ended before completing the turn')
      this.settings.sessions = {
        ...this.settings.sessions,
        [input.threadId]: { sessionId, cwd: resolve(input.cwd), usageBaseline: metrics.snapshot() }
      }
      this.save()
      this.readyToCommit.add(input.threadId)
      return text
    } finally {
      controller.abort()
      query?.close()
      this.queries.delete(input.threadId)
      this.controllers.delete(controller)
      this.activeThreads.delete(input.threadId)
      if (steerTimer) clearInterval(steerTimer)
      input.signal?.removeEventListener('abort', cancel)
      const report = metrics.report()
      try {
        const baseline = metrics.snapshot()
        if (baseline && this.settings.signedIn && !this.stopped) {
          const current = this.settings.sessions?.[input.threadId]
          this.settings.sessions = {
            ...this.settings.sessions,
            [input.threadId]: {
              ...(current?.sessionId === baseline.sessionId ? current : {}),
              sessionId: baseline.sessionId,
              cwd: resolve(input.cwd),
              usageBaseline: baseline
            }
          }
          this.save()
        }
      } finally {
        input.onMetrics?.(report)
      }
      for (const [callId, title] of tools) input.onTool?.({ phase: 'complete', callId, title })
    }
  }
  async logout(): Promise<void> {
    this.settings.signedIn = false
    this.settings.sessions = {}
    this.save()
    for (const controller of this.controllers) controller.abort()
    for (const threadId of this.activeThreads) this.questions.dismissAllForThread(threadId)
    for (const session of this.loginSessions) session.abort.abort()
    for (const query of this.queries.values()) query.close()
    this.queries.clear()
    this.readyToCommit.clear()
    const binary = this.binary()
    if (binary)
      await (this.dependencies.runAuth ?? runAuth)(
        binary,
        ['auth', 'logout'],
        claudeSubscriptionEnvironment(this.configDir)
      )
  }
  stop(): void {
    this.stopped = true
    for (const controller of this.controllers) controller.abort()
    for (const session of this.loginSessions) session.abort.abort()
    for (const child of this.logins) child.kill()
    for (const [threadId, query] of this.queries) {
      query.close()
      this.questions.dismissAllForThread(threadId)
    }
    this.queries.clear()
    this.readyToCommit.clear()
  }
}

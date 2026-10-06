import { createHash } from 'node:crypto'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type NewSessionResponse } from '@agentclientprotocol/sdk'
import type { ConfiguredProvider, ProviderLoginOption, ProviderLoginResult } from '../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { LoginSession } from '../LoginSession'
import { installAntigravity, installedAntigravityBinary, validateManualAntigravityBinary } from './installation'

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity'
type AcpProcess = { child: ChildProcessWithoutNullStreams; connection: ClientConnection; sessionId?: string; cwd?: string; threadId?: string; onUpdate?: (update: unknown) => void; turnSignal?: AbortSignal }
type ProfileSettings = { binaryPath?: string; models?: LlmModelOption[]; signedIn?: boolean; sessions?: Record<string, { sessionId: string; cwd: string; historyKey?: string }> }
const AUTH_PREFIX = 'Open the following link to authenticate the ACP server: '
const BROWSER_MARKER = '__MOUSSE_ANTIGRAVITY_AUTH_URL__'
const ISOLATED_KEYS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT', 'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'ELECTRON_RUN_AS_NODE',
  'BROWSER', 'PYTHONUNBUFFERED'
]

function modelOptions(session: Pick<NewSessionResponse, 'configOptions'>): LlmModelOption[] {
  const selector = session.configOptions?.find((option) => option.id === 'model' && option.type === 'select')
  if (!selector || selector.type !== 'select') return []
  return selector.options.flatMap((item) => 'options' in item
    ? item.options.map((option) => ({ id: option.value, label: option.name }))
    : [{ id: item.value, label: item.name }])
}

function callbackTarget(authUrl: string): { origin: string; pathname: string; state: string } | undefined {
  try {
    if (authUrl.length > 16_384 || /\s/.test(authUrl)) return undefined
    const signIn = new URL(authUrl)
    if (signIn.origin !== 'https://accounts.google.com' || signIn.pathname !== '/o/oauth2/v2/auth' ||
        signIn.username || signIn.password || signIn.hash || signIn.searchParams.get('response_type') !== 'code' ||
        signIn.searchParams.getAll('state').length !== 1 || signIn.searchParams.getAll('redirect_uri').length !== 1) return undefined
    const redirect = new URL(signIn.searchParams.get('redirect_uri') ?? '')
    const state = signIn.searchParams.get('state')
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || Number(redirect.port) < 1024 ||
        redirect.pathname !== '/' || redirect.search || redirect.hash || !state || state.length > 512) return undefined
    return { origin: redirect.origin, pathname: redirect.pathname, state }
  } catch { return undefined }
}

/** Only relay a pasted callback into the loopback listener that this login opened. */
export async function forwardAntigravityCallback(authUrl: string, pastedUrl: string): Promise<void> {
  const target = callbackTarget(authUrl)
  if (!target) throw new Error('Google sign-in did not expose an owned loopback callback')
  const pasted = new URL(pastedUrl)
  if (pasted.origin !== target.origin || pasted.pathname !== target.pathname || pasted.hash ||
      pasted.username || pasted.password || pasted.searchParams.getAll('iss').length > 1 ||
      pasted.searchParams.getAll('state').length !== 1 || pasted.searchParams.get('state') !== target.state ||
      pasted.searchParams.getAll('code').length + pasted.searchParams.getAll('error').length !== 1 ||
      (pasted.searchParams.has('iss') && pasted.searchParams.get('iss') !== 'https://accounts.google.com')) {
    throw new Error('Redirect URL does not match this Google sign-in flow')
  }
  const response = await fetch(pasted, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Google sign-in callback was rejected (${response.status})`)
}

/** Google's 1.1.1 agent emits a human-readable auth line on ACP stdout. */
export function antigravityStdout(onAuthUrl: (url: string) => void): Transform {
  let pending = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = Buffer.concat([pending, chunk])
      let end: number
      while ((end = pending.indexOf(10)) !== -1) {
        if (end > 16 * 1024 * 1024) { done(new Error('Antigravity ACP line is too large')); return }
        const line = pending.subarray(0, end + 1)
        pending = pending.subarray(end + 1)
        const value = line.toString('utf8').trimEnd()
        if (value.startsWith(AUTH_PREFIX)) {
          const url = value.slice(AUTH_PREFIX.length)
          if (!callbackTarget(url)) { done(new Error('Antigravity emitted an invalid Google sign-in URL')); return }
          onAuthUrl(url)
        } else this.push(line)
      }
      if (pending.length > 16 * 1024 * 1024) { done(new Error('Antigravity ACP line is too large')); return }
      done()
    },
    flush(done) {
      if (pending.length) this.push(pending)
      done()
    }
  })
}

export class AntigravityProviderService {
  private readonly settingsPath: string
  private readonly profileDir: string
  private settings: ProfileSettings
  private sessions = new Map<string, AcpProcess>()
  private stopped = false
  private readonly processes = new Set<AcpProcess>()
  private readonly loginSessions = new Set<LoginSession>()

  constructor(private readonly profileHome: string, private readonly installationHome: string, private readonly questions: UserQuestionService) {
    this.profileDir = join(profileHome, 'providers', 'antigravity')
    this.settingsPath = join(this.profileDir, 'settings.json')
    try { this.settings = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as ProfileSettings }
    catch { this.settings = {} }
  }

  private save(): void {
    mkdirSync(this.profileDir, { recursive: true })
    atomicWriteJsonSync(this.settingsPath, this.settings)
  }

  private binary(): string | undefined {
    if (this.settings.binaryPath) {
      try { return validateManualAntigravityBinary(this.settings.binaryPath) } catch { return undefined }
    }
    return installedAntigravityBinary(this.installationHome)
  }

  configured(): boolean { return Boolean(this.settings.signedIn && this.binary()) }
  configuredProvider(): ConfiguredProvider | undefined {
    return this.configured() ? { id: ANTIGRAVITY_PROVIDER_ID, label: 'Google Antigravity', authType: 'oauth', source: 'Google ACP agent' } : undefined
  }
  loginOption(): ProviderLoginOption {
    return { id: ANTIGRAVITY_PROVIDER_ID, label: 'Google Antigravity', authType: 'oauth', configured: this.configured(), description: 'Google ACP agent · personal sign-in' }
  }
  llmProvider(): LlmProviderOption | undefined {
    return this.configured() && this.settings.models?.length
      ? { id: ANTIGRAVITY_PROVIDER_ID, label: 'Google Antigravity', models: this.settings.models }
      : undefined
  }

  private launch(onAuthUrl?: (url: string) => void): AcpProcess {
    if (this.stopped) throw new Error('Antigravity provider is stopped')
    const binary = this.binary()
    if (!binary) throw new Error('Install Google Antigravity or select its official ACP binary first')
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (ISOLATED_KEYS.includes(key.toUpperCase())) delete env[key]
    const geminiHome = join(this.profileDir, 'gemini-home')
    mkdirSync(geminiHome, { recursive: true, mode: 0o700 })
    const acpDir = join(geminiHome, 'antigravity-acp')
    mkdirSync(acpDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(acpDir, 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }), { mode: 0o600 })
    for (const part of [['config', 'skills'], ['antigravity-cli', 'skills']]) {
      const link = join(geminiHome, ...part)
      if (existsSync(link)) continue
      try {
        mkdirSync(dirname(link), { recursive: true })
        symlinkSync(join(homedir(), '.gemini', ...part), link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch { /* A missing optional user skill link does not affect sign-in. */ }
    }
    const browserHelper = join(this.profileDir, process.platform === 'win32' ? 'browser.cmd' : 'browser.sh')
    if (process.platform === 'win32') {
      writeFileSync(browserHelper, `@echo off\r\necho ${BROWSER_MARKER}%1 1>&2\r\n`, { mode: 0o700 })
    } else {
      writeFileSync(browserHelper, `#!/bin/sh\nprintf '${BROWSER_MARKER}%s\\n' "$1" >&2\n`, { mode: 0o700 })
      chmodSync(browserHelper, 0o700)
    }
    env.GEMINI_HOME = geminiHome
    env.AGY_ACP_FORCE_FILE_STORAGE = '1'
    env.ANTIGRAVITY_HARNESS_PATH = join(dirname(binary), process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')
    if (process.platform !== 'win32') {
      const probe = spawnSync(browserHelper, ['https://example.invalid/mousse-browser-probe'], { encoding: 'utf8', timeout: 5_000 })
      if (probe.status !== 0 || probe.stdout || probe.stderr !== `${BROWSER_MARKER}https://example.invalid/mousse-browser-probe\n`) {
        throw new Error('Antigravity browser suppression could not be verified')
      }
    }
    const quotedHelper = `'${browserHelper.replaceAll("'", "'\"'\"'")}'`
    env.BROWSER = `${quotedHelper} %s`
    env.PYTHONUNBUFFERED = '1'
    env.ELECTRON_RUN_AS_NODE = '1'
    const tempDir = join(this.profileHome, 'antigravity-tmp', crypto.randomUUID())
    mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') { env.TEMP = tempDir; env.TMP = tempDir }
    else env.TMPDIR = tempDir
    const child = spawn(binary, process.platform === 'linux' ? ['--uid='] : [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const app = client({ name: 'Mousse' })
    const active: AcpProcess = { child, connection: undefined! }
    app.onRequest(methods.client.session.requestPermission, async ({ params: request }) => {
      if (active.turnSignal?.aborted || active.connection.signal.aborted || !active.threadId || !request.options.length) return { outcome: { outcome: 'cancelled' } }
      const answers = await this.questions.requestAnswers([{
        id: 'permission', prompt: request.toolCall.title ?? 'Allow Antigravity to run this tool?',
        options: request.options.map((option) => ({ id: option.optionId, label: option.name }))
      }], active.threadId)
      if (active.turnSignal?.aborted || active.connection.signal.aborted) return { outcome: { outcome: 'cancelled' } }
      const answer = answers.permission
      const selected = request.options.find((option) => option.optionId === answer)
      return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
    })
    app.onRequest(methods.client.fs.readTextFile, async ({ params: request }) => {
      const path = this.allowedPath(active, request.path)
      const lines = readFileSync(path, 'utf8').split('\n')
      const from = Math.max(0, (request.line ?? 1) - 1)
      return { content: lines.slice(from, request.limit ? from + request.limit : undefined).join('\n') }
    })
    app.onRequest(methods.client.fs.writeTextFile, async ({ params: request }) => {
      const path = this.allowedPath(active, request.path)
      if (!active.threadId) throw new Error('ACP file write has no thread')
      const answer = await this.questions.requestAnswers([{
        id: 'write', prompt: `Allow Antigravity to write ${relative(active.cwd!, path)}?`,
        options: [{ id: 'allow', label: 'Allow this edit' }, { id: 'reject', label: 'Reject' }]
      }], active.threadId)
      if (answer.write !== 'allow') throw new Error('Antigravity file write was rejected')
      active.turnSignal?.throwIfAborted()
      active.connection.signal.throwIfAborted()
      const approvedPath = this.allowedPath(active, request.path)
      mkdirSync(dirname(approvedPath), { recursive: true })
      writeFileSync(approvedPath, request.content, 'utf8')
      return {}
    })
    app.onNotification(methods.client.session.update, ({ params: notification }) => active.onUpdate?.(notification.update))
    const acceptAuthUrl = (url: string) => {
      if (!callbackTarget(url)) return
      if (onAuthUrl) onAuthUrl(url)
      else active.connection.close(new Error('Sign in to Antigravity in Settings before chatting'))
    }
    const protocolOutput = child.stdout.pipe(antigravityStdout(acceptAuthUrl))
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(protocolOutput) as ReadableStream<Uint8Array>)
    active.connection = app.connect(stream)
    child.stderr.setEncoding('utf8')
    let stderrPending = ''
    child.stderr.on('data', (chunk: string) => {
      const lines = `${stderrPending}${chunk}`.split('\n')
      stderrPending = lines.pop() ?? ''
      if (stderrPending.length > 20_000) stderrPending = ''
      for (const raw of lines) {
        const line = raw.trimEnd()
        const url = line.startsWith(AUTH_PREFIX) ? line.slice(AUTH_PREFIX.length)
          : line.startsWith(BROWSER_MARKER) ? line.slice(BROWSER_MARKER.length) : undefined
        if (url) acceptAuthUrl(url)
      }
    })
    this.processes.add(active)
    child.on('exit', () => {
      this.processes.delete(active)
      active.connection.close()
      void rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    })
    child.on('error', (error) => active.connection.close(error))
    return active
  }

  private allowedPath(active: AcpProcess, path: string): string {
    active.turnSignal?.throwIfAborted()
    active.connection.signal.throwIfAborted()
    if (!active.cwd || !isAbsolute(path)) throw new Error('ACP file request has no workspace')
    const root = resolve(active.cwd)
    const target = resolve(path)
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('ACP file request is outside the workspace')
    const realRoot = realpathSync(root)
    let nearest = target
    for (;;) {
      try { lstatSync(nearest); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        nearest = dirname(nearest)
      }
    }
    const realNearest = realpathSync(nearest)
    const realRel = relative(realRoot, realNearest)
    if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
      throw new Error('ACP file request resolves outside the workspace')
    }
    return target
  }

  private async initialize(process: AcpProcess, clientFileSystem = false): Promise<void> {
    const response = await process.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: clientFileSystem, writeTextFile: clientFileSystem }, terminal: false },
      clientInfo: { name: 'Mousse', version: '0.1.1' }
    })
    if (response.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported Antigravity ACP protocol ${response.protocolVersion}`)
  }

  private close(process: AcpProcess): void {
    process.connection.close()
    if (process.child.exitCode === null && process.child.signalCode === null) {
      process.child.kill()
      const timer = setTimeout(() => { if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL') }, 3_000)
      timer.unref?.()
    }
  }

  async login(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    this.loginSessions.add(session)
    try {
      if (this.stopped) throw new Error('Antigravity provider is stopped')
      session.abort.signal.throwIfAborted()
      return await this.runLogin(session, cwd)
    } catch (error) {
      return { success: false, sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.loginSessions.delete(session)
      // Withdraw the fallback callback prompt and release profile-owned login work.
      session.abort.abort()
    }
  }

  private async runLogin(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    const currentBinary = this.binary()
    {
      const method = await session.createAuthCallbacks().prompt({ type: 'select', message: 'Set up Google Antigravity ACP', options: [
        ...(currentBinary ? [{ id: 'existing', label: 'Use current Google agent', description: currentBinary }] : []),
        { id: 'install', label: 'Install official Google agent', description: 'Download pinned, verified release 1.1.1' },
        { id: 'manual', label: 'Choose existing agent binary', description: 'Official agent and localharness_external must be together' }
      ] })
      if (method === 'install') {
        await installAntigravity(this.installationHome, session.abort.signal, (message) => session.emitEvent({ sessionId: session.sessionId, type: 'progress', message }))
        delete this.settings.binaryPath
        this.save()
      }
      else if (method === 'manual') {
        const path = await session.createAuthCallbacks().prompt({ type: 'text', message: 'Path to Google agy_acp_server binary' })
        this.settings.binaryPath = validateManualAntigravityBinary(path)
        this.save()
      } else if (method !== 'existing' || !currentBinary) throw new Error('Antigravity setup cancelled')
    }
    session.abort.signal.throwIfAborted()
    let authUrl: string | undefined
    const process = this.launch((url) => {
      authUrl = url
      session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url, usesCallbackServer: true,
        instructions: 'Sign in through Google. If the browser is on another machine, paste its final redirect URL here.' })
    })
    session.abort.signal.addEventListener('abort', () => this.close(process), { once: true })
    try {
      void (async () => {
        while (!session.abort.signal.aborted) {
          const callback = await session.waitForCallbackUrl()
          try {
            if (!authUrl) throw new Error('Wait for Google to start sign-in before forwarding a redirect')
            await forwardAntigravityCallback(authUrl, callback)
            return
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (authUrl) session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url: authUrl, usesCallbackServer: true, instructions: message })
            else session.emitEvent({ sessionId: session.sessionId, type: 'progress', message })
          }
        }
      })().catch(() => undefined)
      await this.initialize(process)
      await process.connection.agent.request(methods.agent.authenticate, { methodId: 'oauth-personal' })
      const newSession = await process.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      session.abort.signal.throwIfAborted()
      const models = modelOptions(newSession)
      if (!models.length) throw new Error('Google agent did not confirm account model access')
      this.settings = { ...this.settings, signedIn: true, models }
      this.save()
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      return { success: false, sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }
    } finally { this.close(process) }
  }

  private historyKey(history: string): string {
    return createHash('sha256').update(history).digest('hex')
  }

  /** Record only the canonical history that the owning turn durably committed. */
  commitConversation(threadId: string, history: string): void {
    const saved = this.settings.sessions?.[threadId]
    if (!saved || !this.sessions.has(threadId)) return
    saved.historyKey = this.historyKey(history)
    this.save()
  }

  async chat(input: { threadId: string; cwd: string; model: string; prompt: string; appletInstructions?: string; history?: string; images?: ChatImageAttachment[]; signal?: AbortSignal; onText: (text: string) => void; drainSteer?: () => string | undefined; onSteer?: (text: string) => void; onTool?: (event: { phase: 'start' | 'complete'; callId: string; title: string; toolName?: string }) => void }): Promise<string> {
    input.signal?.throwIfAborted()
    if (!this.configured()) throw new Error('Antigravity is not signed in')
    const historyKey = this.historyKey(input.history ?? '')
    const saved = this.settings.sessions?.[input.threadId]
    let active = this.sessions.get(input.threadId)
    if (active && (active.connection.signal.aborted || active.cwd !== input.cwd || saved?.historyKey !== historyKey)) {
      this.close(active)
      this.sessions.delete(input.threadId)
      active = undefined
    }
    const freshProcess = !active
    active ??= this.launch()
    active.threadId = input.threadId
    active.cwd = input.cwd
    active.turnSignal = input.signal
    const current = active
    const abort = () => {
      this.questions.autoRejectPendingForThread(input.threadId)
      // Closing also aborts setup RPCs; a lost startup abort must never dispatch a prompt.
      this.close(current)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    let text = ''
    const toolTitles = new Map<string, string>()
    let resumed = !freshProcess
    let steerTimer: ReturnType<typeof setInterval> | undefined
    let steerFailure: unknown
    try {
      input.signal?.throwIfAborted()
      if (freshProcess) {
        await this.initialize(active, true)
        input.signal?.throwIfAborted()
        let session: Pick<NewSessionResponse, 'configOptions'>
        if (saved?.cwd === input.cwd && saved.historyKey === historyKey) {
          try {
            session = await active.connection.agent.request(methods.agent.session.resume, { sessionId: saved.sessionId, cwd: input.cwd, mcpServers: [] })
            active.sessionId = saved.sessionId
            resumed = true
          } catch (error) {
            input.signal?.throwIfAborted()
            active.connection.signal.throwIfAborted()
            session = await active.connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers: [] })
            active.sessionId = (session as NewSessionResponse).sessionId
          }
        } else {
          session = await active.connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers: [] })
          active.sessionId = (session as NewSessionResponse).sessionId
        }
        input.signal?.throwIfAborted()
        // Until the owning turn commits its updated history, this ACP session is
        // deliberately non-resumable after a crash or a failed/aborted prompt.
        this.settings.sessions = { ...this.settings.sessions, [input.threadId]: { sessionId: active.sessionId, cwd: input.cwd } }
        this.save()
        const models = modelOptions(session)
        if (models.length) { this.settings.models = models; this.save() }
        this.sessions.set(input.threadId, active)
      }
      active.onUpdate = (update) => {
        if (!update || typeof update !== 'object') return
        const event = update as { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string; name?: string; status?: string; configOptions?: NewSessionResponse['configOptions'] }
        if (event.sessionUpdate === 'agent_message_chunk' && event.content?.type === 'text') {
          text += event.content.text ?? ''
          input.onText(text)
        }
        if (event.sessionUpdate === 'tool_call' && event.toolCallId) {
          const title = event.name === 'start_subagent' ? `Antigravity subagent: ${event.title ?? 'Task'}` : event.title ?? event.name ?? 'Antigravity tool'
          toolTitles.set(event.toolCallId, title)
          input.onTool?.({ phase: 'start', callId: event.toolCallId, title, toolName: event.name })
        }
        if (event.sessionUpdate === 'tool_call_update' && event.toolCallId && (event.status === 'completed' || event.status === 'failed')) {
          input.onTool?.({ phase: 'complete', callId: event.toolCallId, title: event.title ?? toolTitles.get(event.toolCallId) ?? 'Antigravity tool' })
          toolTitles.delete(event.toolCallId)
        }
        if (event.sessionUpdate === 'config_option_update' && event.configOptions) {
          const updated = modelOptions({ configOptions: event.configOptions })
          if (updated.length) { this.settings.models = updated; this.save() }
        }
      }
      if (!active.sessionId) throw new Error('Antigravity session was not created')
      if (!this.settings.models?.some((model) => model.id === input.model)) throw new Error('This Antigravity model is unavailable for the signed-in account')
      await active.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: active.sessionId, configId: 'model', value: input.model })
      input.signal?.throwIfAborted()
      const imageBlocks = (input.images ?? []).map((image) => {
        const mimeType = image.mimeType.toLowerCase()
        if (!['image/bmp', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || Buffer.byteLength(image.data, 'base64') > 10 * 1024 * 1024) {
          throw new Error(`Antigravity cannot send image ${image.name}; use BMP, JPEG, PNG, or WebP under 10 MiB`)
        }
        return { type: 'image' as const, data: image.data, mimeType }
      })
      const pendingSteers: string[] = []
      let prompting = false
      let cancelSent = false
      const collectSteer = () => {
        if (input.signal?.aborted || steerFailure) return
        try {
          const steer = input.drainSteer?.()?.trim()
          if (!steer) return
          input.onSteer?.(steer)
          pendingSteers.push(steer)
          if (prompting && !cancelSent) {
            cancelSent = true
            this.questions.autoRejectPendingForThread(input.threadId)
            void current.connection.agent.notify(methods.agent.session.cancel, { sessionId: current.sessionId! })
              .catch((error) => { steerFailure = error; this.close(current) })
          }
        } catch (error) { steerFailure = error; this.close(current) }
      }
      steerTimer = setInterval(collectSteer, 100)
      steerTimer.unref?.()
      const history = !resumed && input.history
        ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
        : ''
      let prompt = history + (input.appletInstructions ? input.appletInstructions + '\n\nCurrent request:\n' : '') + (input.prompt || '(image attachment)')
      let attachments = imageBlocks
      for (;;) {
        input.signal?.throwIfAborted()
        if (steerFailure) throw steerFailure
        collectSteer()
        if (pendingSteers.length) prompt += '\n\nAdditional guidance:\n' + pendingSteers.splice(0).join('\n')
        prompting = true
        cancelSent = false
        // Any accepted prompt makes the old history fingerprint stale until commit.
        delete this.settings.sessions![input.threadId].historyKey
        this.save()
        await active.connection.agent.request(methods.agent.session.prompt, { sessionId: active.sessionId,
          prompt: [{ type: 'text', text: prompt }, ...attachments] })
        prompting = false
        input.signal?.throwIfAborted()
        collectSteer()
        if (steerFailure) throw steerFailure
        if (!pendingSteers.length) break
        prompt = pendingSteers.splice(0).join('\n')
        attachments = []
        if (text) text += '\n\n'
      }
      for (const [callId, title] of toolTitles) input.onTool?.({ phase: 'complete', callId, title })
      return text
    } catch (error) {
      this.close(current)
      this.sessions.delete(input.threadId)
      if (steerFailure) throw steerFailure
      throw error
    } finally {
      if (steerTimer) clearInterval(steerTimer)
      input.signal?.removeEventListener('abort', abort)
      current.onUpdate = undefined
      current.turnSignal = undefined
    }
  }

  /** Explicit model-picker refresh; never run this from background health checks. */
  async refreshModels(cwd: string): Promise<LlmModelOption[]> {
    if (!this.configured()) throw new Error('Antigravity is not signed in')
    const active = this.launch()
    try {
      await this.initialize(active)
      const session = await active.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      const models = modelOptions(session)
      if (!models.length) throw new Error('Google agent did not return account models')
      this.settings.models = models
      this.save()
      return models
    } finally { this.close(active) }
  }

  async logout(): Promise<void> {
    for (const session of this.loginSessions) session.abort.abort()
    this.closeAll()
    try {
      if (this.binary()) {
        const active = this.launch()
        try {
          await this.initialize(active)
          await active.connection.agent.request(methods.agent.logout, {})
        } finally { this.close(active) }
      }
    } finally {
      this.settings.signedIn = false
      this.settings.models = []
      this.settings.sessions = {}
      this.save()
    }
  }
  closeAll(): void { for (const active of this.processes) this.close(active); this.sessions.clear() }
  stop(): void {
    this.stopped = true
    for (const session of this.loginSessions) session.abort.abort()
    this.closeAll()
  }
}

import type { ParsedArgs } from '../parseArgs'
import { flagString } from '../parseArgs'
import { connectDaemonClient, type DaemonClient } from '../daemonClient'
import { writeError, writeOutput } from '../output'
import {
  BROWSER_SETUP_IN_APP_NOTE,
  BROWSER_SETUP_OPERATION_ID_PATTERN,
  type BrowserSetupStatus
} from '../../shared/browser/setup'

export const BROWSER_HELP = `Usage:
  mousse-cli browser status
  mousse-cli browser install [--wait | --no-wait]
  mousse-cli browser cancel <operation-id>

Installs official Stable Chrome for Testing into the daemon-owned managed
browser root. The command is an explicit user action; tool execution never
auto-installs. In-app browser tabs do not need this download.

status reports availability and any shared install operation. install starts
the daemon-owned download and returns an operation id immediately; --wait
(the default) polls that same operation. cancel requires the exact operation
id. Disconnecting or Ctrl+C during --wait stops monitoring only — it does not
cancel the install.

No --channel, --version, --url, --path, or --hash flags are accepted.
`

const COMMANDS = new Set(['status', 'install', 'cancel'])
const COMMON_FLAGS = ['profile', 'mode']
const FLAGS: Record<string, string[]> = {
  status: [],
  install: ['wait', 'no-wait'],
  cancel: []
}
const SWITCHES = new Set(['wait', 'no-wait'])
const FORBIDDEN = ['channel', 'version', 'url', 'path', 'hash', 'origin', 'root', 'executable', 'sha256']

export interface BrowserCliRequest {
  command: 'status' | 'install' | 'cancel'
  operationId?: string
  wait: boolean
}

export interface BrowserCliIO {
  emit(value: unknown, text?: string): void
  signal?: AbortSignal
  pollMs?: number
}

export type BrowserCliClient = Pick<DaemonClient, 'request'>

function value(flags: Map<string, string | boolean>, key: string): string {
  const result = flagString(flags, key)
  if (!result || !result.trim()) throw new Error('--' + key + ' requires a value')
  return result
}

/** Validate arguments before connecting or admitting any work. */
export function prepareBrowserCommand(args: ParsedArgs): BrowserCliRequest {
  const command = args.subcommand ?? ''
  if (!command || command === 'help' || args.globals.help) {
    throw new Error('browser requires status, install, or cancel')
  }
  if (!COMMANDS.has(command)) throw new Error('Unknown browser command: ' + command)
  if (args.globals.provider || args.globals.model || args.globals.apiKey || args.globals.continueSession) {
    throw new Error('Browser setup does not accept provider/model/API-key overrides or --continue')
  }
  const allowed = new Set([...COMMON_FLAGS, ...FLAGS[command]])
  for (const [key, flag] of args.flags) {
    if (FORBIDDEN.includes(key)) throw new Error('Browser setup does not accept --' + key)
    if (!allowed.has(key)) throw new Error('Unsupported flag for browser ' + command + ': --' + key)
    if (SWITCHES.has(key)) {
      if (flag !== true) throw new Error('--' + key + ' is a switch; do not supply a value')
    } else value(args.flags, key)
  }
  if (command === 'cancel') {
    if (args.positional.length !== 1) throw new Error('browser cancel requires exactly one operation id')
    const operationId = args.positional[0]
    if (!BROWSER_SETUP_OPERATION_ID_PATTERN.test(operationId)) throw new Error('Operation id must be a UUID')
    return { command, operationId, wait: false }
  }
  if (args.positional.length !== 0) throw new Error('browser ' + command + ' accepts no positional arguments')
  if (args.flags.has('wait') && args.flags.has('no-wait')) throw new Error('Choose --wait or --no-wait')
  return { command: command as 'status' | 'install', wait: command === 'install' ? !args.flags.has('no-wait') : false }
}

function formatStatus(status: BrowserSetupStatus): string {
  const lines = [
    `Managed Chrome: ${status.availability}`,
    `Channel: ${status.channel}`,
    `Platform: ${status.platform.id}${status.platform.supported ? '' : ' (unsupported)'}`,
    status.version ? `Version: ${status.version}` : undefined,
    status.message,
    BROWSER_SETUP_IN_APP_NOTE
  ]
  if (status.operation) {
    const op = status.operation
    lines.push(`Operation: ${op.id} (${op.state})`)
    lines.push(`Phase: ${op.progress.phase}`)
    if (op.error) lines.push(`Error: ${op.error.message}`)
  }
  return lines.filter((line): line is string => Boolean(line)).join('\n')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal?.aborted) done()
    else signal?.addEventListener('abort', done, { once: true })
  })
}

function settled(status: BrowserSetupStatus): number | undefined {
  const state = status.operation?.state
  if (state === 'succeeded' || (status.availability === 'ready' && state !== 'running' && state !== 'cancelling')) return 0
  if (state === 'failed' || status.availability === 'unsupported' || status.availability === 'blocked') return 1
  if (state === 'cancelled') return 4
  return undefined
}

async function poll(
  client: BrowserCliClient,
  io: BrowserCliIO,
  initial?: BrowserSetupStatus
): Promise<number> {
  let current = initial
  for (;;) {
    if (!current) current = await client.request<BrowserSetupStatus>('browser.setup.status', {})
    io.emit(current, formatStatus(current))
    const code = settled(current)
    if (code !== undefined) return code
    if (io.signal?.aborted) return 130
    await delay(io.pollMs ?? 500, io.signal)
    if (io.signal?.aborted) return 130
    current = await client.request<BrowserSetupStatus>('browser.setup.status', {})
  }
}

export async function executeBrowserCommand(
  request: BrowserCliRequest,
  client: BrowserCliClient,
  io: BrowserCliIO
): Promise<number> {
  if (request.command === 'status') {
    const status = await client.request<BrowserSetupStatus>('browser.setup.status', {})
    io.emit(status, formatStatus(status))
    return 0
  }
  if (request.command === 'cancel') {
    const result = await client.request<{ operationId: string; status: BrowserSetupStatus }>('browser.setup.cancel', {
      operationId: request.operationId
    })
    if (result.operationId !== request.operationId) throw new Error('Daemon cancelled a different install operation')
    io.emit(result, formatStatus(result.status))
    return 0
  }
  const started = await client.request<{ operationId: string; status: BrowserSetupStatus }>('browser.setup.install', {})
  io.emit(started, `Started managed browser install ${started.operationId}\n${formatStatus(started.status)}`)
  if (!request.wait) return 0
  return poll(client, io, started.status)
}

export async function runBrowser(args: ParsedArgs): Promise<void> {
  if (!args.subcommand || args.subcommand === 'help' || args.globals.help) {
    process.stdout.write(BROWSER_HELP)
    return
  }
  let client: DaemonClient | undefined
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  try {
    const request = prepareBrowserCommand(args)
    client = await connectDaemonClient({ homeDir: args.globals.homeDir || undefined })
    process.on('SIGINT', interrupt)
    process.exitCode = await executeBrowserCommand(request, client, {
      emit: (value, text) => {
        if (args.globals.mode === 'json') writeOutput(args.globals.mode, value)
        else writeOutput(args.globals.mode, value, () => text ?? '')
      },
      signal: controller.signal
    })
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error), args.globals.mode)
    process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', interrupt)
    await client?.close()
  }
}

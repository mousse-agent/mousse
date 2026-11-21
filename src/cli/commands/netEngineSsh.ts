import { connectDaemonClient } from '../daemonClient'
import { engineLimits } from '../../mms/netEngine/limits'
import type { ParsedArgs } from '../parseArgs'

/** The line written before anything else on stdout (1b §3.3); the other computer discards what came before it. */
export const SSH_MARKER = 'mousse-ssh/1'

export interface NetEngineSshIo {
  stdin: NodeJS.ReadableStream
  stdout: { write(text: string): unknown }
  /** Asks the running daemon; undefined when none runs (it is never started). */
  serve(request: unknown): Promise<Record<string, unknown> | undefined>
}

/**
 * `mousse-cli net-engine ssh` (1b §3.4): what another computer's Add over SSH runs here over SSH. It reads one
 * JSON request from stdin (`{op: "profiles"}` or `{op: "prepare", …}`), writes the marker, then the daemon's reply
 * as one JSON line. It never starts the daemon: with none running it answers `remote_not_running`.
 */
export async function runNetEngineSsh(io: NetEngineSshIo): Promise<void> {
  io.stdout.write(`${SSH_MARKER}\n`)
  let reply: Record<string, unknown>
  try {
    const request = JSON.parse(await readRequest(io.stdin)) as unknown
    reply = (await io.serve(request)) ?? { error: 'remote_not_running' }
  } catch (error) {
    reply = { error: error instanceof SyntaxError ? 'bad_request' : 'remote_failed' }
  }
  io.stdout.write(`${JSON.stringify(reply)}\n`)
}

/**
 * One line from stdin: at most `MOUSSE_NET_ENGINE_SSH_REMOTE_REQUEST_MAX_BYTES`, within
 * `MOUSSE_NET_ENGINE_SSH_REMOTE_READ_MS` (both can only be lowered). Too long or too slow is a bad request.
 */
function readRequest(stdin: NodeJS.ReadableStream): Promise<string> {
  const { sshRemoteRequestMaxBytes, sshRemoteReadMs } = engineLimits()
  return new Promise((resolve, reject) => {
    let text = ''
    const finish = (error?: Error, line?: string): void => {
      clearTimeout(timer)
      stdin.removeAllListeners('data')
      stdin.pause?.()
      if (error) reject(error)
      else resolve(line ?? text)
    }
    const timer = setTimeout(() => finish(new SyntaxError('request too slow')), sshRemoteReadMs)
    timer.unref?.()
    stdin.setEncoding?.('utf8')
    stdin.on('data', (chunk: string) => {
      text += chunk
      const end = text.indexOf('\n')
      const line = end >= 0 ? text.slice(0, end) : text
      if (Buffer.byteLength(line) > sshRemoteRequestMaxBytes) return finish(new SyntaxError('request too long'))
      if (end >= 0) finish(undefined, line)
    })
    stdin.on('end', () => finish())
    stdin.on('error', (error) => finish(error))
  })
}

/** The command line's entry: the real daemon, asked with `disableAutoStart` (the control lets it start one). */
export async function runNetEngineCommand(
  args: ParsedArgs,
  connect: typeof connectDaemonClient = connectDaemonClient,
  io: { stdin: NodeJS.ReadableStream; stdout: { write(text: string): unknown } } = process
): Promise<void> {
  if (args.subcommand !== 'ssh') {
    process.stderr.write('usage: mousse-cli net-engine ssh\n')
    process.exitCode = 2
    return
  }
  const { engineControl } = await import('../../mms/netEngine/limits')
  await runNetEngineSsh({
    stdin: io.stdin,
    stdout: io.stdout,
    serve: async (request) => {
      let client
      try {
        client = await connect({
          homeDir: args.globals.homeDir || undefined,
          disableAutoStart: !engineControl('remote-autostart')
        })
      } catch {
        return undefined
      }
      try {
        return await client.request<Record<string, unknown>>('netEngine.ssh.serve', { request })
      } finally {
        await client.close()
      }
    }
  })
}

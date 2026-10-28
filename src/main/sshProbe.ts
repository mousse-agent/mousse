/**
 * The sign-in check after an editor connection to a computer was found open: `ssh -o BatchMode=yes <name> exit`,
 * one login that never asks a question, run against Mousse's own file of names (`-F`, so it does not need the
 * `Include` line yet). It is advice only. It cannot tell a person who will type a password, a passphrase or touch a
 * key from one who cannot sign in, so what it finds never stops an editor from starting. It only ever names a `Host`
 * of Mousse's own file, so it connects nowhere but through that name's ProxyCommand. Tests give `SshProbeIo`
 * fakes, so no `ssh` starts.
 */
import { spawn } from 'node:child_process'
import { findSshClients } from '../mms/net/editor/sshConfig'
import type { SshProbeOutcome } from './remoteEditorFlow'

/** Short, because the check is only advice and a key that waits for a touch would hold the editor back. */
export const SSH_PROBE_TIMEOUT_MS = 6_000
/** What Mousse writes as a `Host` name: lowercase letters, digits and `-`, never a leading `-` (an option). */
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/u

export interface SshProbeRun {
  code: number | null
  stderr: string
  timedOut: boolean
}

export interface SshProbeIo {
  /** The `ssh` programs on this computer, best first. */
  clients(): string[]
  run(program: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<SshProbeRun>
}

/** The arguments of the check. No question can be asked, and no password is tried. `config` is Mousse's own file of names. */
export function sshProbeArguments(alias: string, config: string): string[] {
  if (!ALIAS.test(alias)) throw new Error('That is not one of Mousse’s SSH names.')
  if (!config || config.startsWith('-') || config.includes('\0')) throw new Error('That is not a file of SSH names.')
  return [
    '-F', config,
    '-o', 'BatchMode=yes',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'ConnectTimeout=5',
    '-o', 'LogLevel=ERROR',
    '--', alias, 'exit'
  ]
}

const realIo: SshProbeIo = {
  clients: () => findSshClients(),
  run: (program, args, timeoutMs, env) =>
    new Promise((resolve) => {
      let stderr = ''
      let timedOut = false
      const child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < 8_192) stderr += chunk.toString('utf8')
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, stderr: `${stderr}${error.message}`, timedOut })
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stderr, timedOut })
      })
    })
}

/**
 * Runs the check with the first `ssh` found, in the environment the editor will start with (so a ProxyCommand sees
 * what the editor's would). `skipped` when there is none: the editor has its own way to ask.
 */
export async function runSshProbe(
  alias: string,
  config: string,
  env: NodeJS.ProcessEnv,
  io: SshProbeIo = realIo
): Promise<SshProbeOutcome> {
  const args = sshProbeArguments(alias, config)
  const [client] = io.clients()
  if (!client) return { skipped: true }
  const run = await io.run(client, args, SSH_PROBE_TIMEOUT_MS, env)
  if (run.timedOut) return { ok: false, stderr: 'ssh did not finish signing in.' }
  return run.code === 0 ? { ok: true } : { ok: false, stderr: run.stderr }
}

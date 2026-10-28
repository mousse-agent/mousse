/**
 * The sign-in check before an editor opens a folder over one of Mousse's SSH names: `ssh -o BatchMode=yes
 * <name> exit`, one login that never asks a question. A refused key or a broken setting shows up here as a plain
 * message, not as an editor window that waits. It only ever names a `Host` of Mousse's own file, so it connects
 * nowhere but through that name's ProxyCommand. Tests give `SshProbeIo` fakes, so no `ssh` starts.
 */
import { spawn } from 'node:child_process'
import { findSshClients } from '../mms/net/editor/sshConfig'
import type { SshProbeOutcome } from './remoteEditorFlow'

export const SSH_PROBE_TIMEOUT_MS = 20_000
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
  run(program: string, args: string[], timeoutMs: number): Promise<SshProbeRun>
}

/** The arguments of the check. No question can be asked, and no password is tried. */
export function sshProbeArguments(alias: string): string[] {
  if (!ALIAS.test(alias)) throw new Error('That is not one of Mousse’s SSH names.')
  return [
    '-o', 'BatchMode=yes',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR',
    '--', alias, 'exit'
  ]
}

const realIo: SshProbeIo = {
  clients: () => findSshClients(),
  run: (program, args, timeoutMs) =>
    new Promise((resolve) => {
      let stderr = ''
      let timedOut = false
      const child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
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

/** Runs the check with the first `ssh` found. `skipped` when there is none: the editor has its own way to ask. */
export async function runSshProbe(alias: string, io: SshProbeIo = realIo): Promise<SshProbeOutcome> {
  const args = sshProbeArguments(alias)
  const [client] = io.clients()
  if (!client) return { skipped: true }
  const run = await io.run(client, args, SSH_PROBE_TIMEOUT_MS)
  if (run.timedOut) return { ok: false, stderr: 'ssh did not finish signing in within 20 seconds.' }
  return run.code === 0 ? { ok: true } : { ok: false, stderr: run.stderr }
}

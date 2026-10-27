import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SshCheckProblem } from '../../../shared/net/local'
import { configPath, describeSshFailure, type SshEndpoint } from '../transports/ssh'
import { keyFingerprint, parseKnownHosts, type OfferedKey } from './knownHosts'
import { runProcess } from './runner'
import { targetArguments, type SshContext } from './remote'

const RETRIEVE_TIMEOUT_MS = 20_000

export type Retrieved =
  | { ok: true; offered: OfferedKey; fingerprint: string }
  | { ok: false; problem: SshCheckProblem; detail: string }

/**
 * Phase 1 of a check: ask the host for its key with `ssh` itself, so the user's own configuration
 * (HostName, Port, HostKeyAlias) decides what is looked up. Every authentication method is off and
 * `-N` requests no session, so the connection ends at authentication by design (`Permission
 * denied`, exit 255) and the key lands in a temporary file in the exact form ssh looks it up. Never
 * `ssh-keyscan`: it ignores `~/.ssh/config`. The temporary file is used for nothing else: not to
 * authenticate and not to run a command.
 *
 * `HashKnownHosts=no` and `CheckHostIP=no` exist because the line is parsed: Debian and Ubuntu ship
 * `HashKnownHosts yes`, which would make the first field unusable as a lookup name, and
 * `CheckHostIP yes` would write `host,<ip>`.
 */
export async function retrieveHostKey(
  context: SshContext,
  endpoint: SshEndpoint,
  endpointText: string,
  scratchRoot: string,
  signal?: AbortSignal
): Promise<Retrieved> {
  await mkdir(scratchRoot, { recursive: true })
  const directory = await mkdtemp(join(scratchRoot, 'hostkey-'))
  const file = join(directory, 'known_hosts')
  try {
    const result = await runProcess(
      context.binary,
      [
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile="${configPath(file)}"`,
        '-o',
        `GlobalKnownHostsFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        '-o',
        'HashKnownHosts=no',
        '-o',
        'CheckHostIP=no',
        '-o',
        'UpdateHostKeys=no',
        '-o',
        'VerifyHostKeyDNS=no',
        '-o',
        'PubkeyAuthentication=no',
        '-o',
        'PasswordAuthentication=no',
        '-o',
        'KbdInteractiveAuthentication=no',
        '-o',
        'GSSAPIAuthentication=no',
        '-o',
        'HostbasedAuthentication=no',
        '-o',
        'BatchMode=yes',
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ForwardX11=no',
        '-o',
        'PermitLocalCommand=no',
        '-o',
        'LogLevel=ERROR',
        '-o',
        'ConnectTimeout=10',
        '-N',
        '-T',
        ...targetArguments(endpoint)
      ],
      { timeoutMs: RETRIEVE_TIMEOUT_MS, signal }
    )
    if (result.missing)
      return {
        ok: false,
        problem: 'unreachable',
        detail: 'The ssh command was not found. Install OpenSSH to add this machine.'
      }
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      // ssh wrote nothing.
    }
    const lines = parseKnownHosts(text)
    if (lines.length !== 1) {
      const timedOut = result.timedOut ? ' Connection timed out.' : ''
      return {
        ok: false,
        problem: /Host key verification failed|HOST IDENTIFICATION/i.test(result.stderr)
          ? 'host_key_failed'
          : 'unreachable',
        detail:
          lines.length > 1
            ? `${endpointText} offered more than one host key; Mousse expected one.`
            : `${describeSshFailure(result.stderr, endpointText, 0)}${timedOut}`
      }
    }
    const [line] = lines
    if (line!.names.startsWith('|1|'))
      return {
        ok: false,
        problem: 'host_key_failed',
        detail: 'ssh ignored HashKnownHosts=no, so the host name cannot be read from its key line.'
      }
    const name = line!.names.split(',')[0]!
    return {
      ok: true,
      offered: { name, type: line!.type, key: line!.key },
      fingerprint: keyFingerprint(line!.key)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

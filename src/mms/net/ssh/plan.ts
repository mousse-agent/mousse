import type {
  SshCheckResult,
  SshPlan,
  SshPlanStep,
  SshPrerequisite
} from '../../../shared/net/local'
import { assetName, assetUrl, INSTALL_RELATIVE, LAUNCHER_RELATIVE, UNIT_RELATIVE } from './scripts'

export const PREREQUISITE = {
  keys: 'SSH key or agent usable from the Mousse daemon',
  forwarding: 'sshd allows TCP forwarding (AllowTcpForwarding)',
  system: 'Linux x86_64, or Mousse already installed',
  downloader: 'curl or wget',
  checksum: 'sha256sum or shasum',
  systemd: 'systemd user services (systemctl)',
  disk: 'At least 500 MB free in the home directory',
  release: 'A release build of Mousse on this computer',
  home: 'A plain home directory path',
  launcher: 'No unrelated file at ~/.local/bin/mousse-cli',
  unit: 'No unrelated mousse-mms service unit'
} as const

/** True when `version` sorts before `than` (numeric parts, then a prerelease before its release). */
export function isOlderVersion(version: string, than: string): boolean {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/u.exec(value)
    return match
      ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] }
      : undefined
  }
  const a = parse(version),
    b = parse(than)
  if (!a || !b) return false
  for (let index = 0; index < 3; index++)
    if (a.parts[index] !== b.parts[index]) return a.parts[index]! < b.parts[index]!
  if (a.pre === undefined) return false
  return b.pre === undefined ? true : a.pre < b.pre
}

/** The port the host's daemon listens on, stable per host so the plan and the run agree. */
export function defaultDaemonPort(host: string): number {
  let hash = 2166136261
  for (const char of host) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return 40000 + (hash % 20000)
}

/** Name the step ids once: the plan, the journal and the progress list all use them. */
export const STEP_TITLES: Record<string, string> = {
  install: 'Install Mousse on the machine',
  service: 'Install and start the Mousse service',
  linger: 'Keep the service running after logout',
  join: 'Join this computer’s devices',
  addon: 'Turn on SSH access on the machine',
  approval: 'Approve SSH for the machine here'
}

/**
 * The dry run shown before anything changes: a pure function of the check, with no access to the
 * machine. Missing prerequisites and collisions block it, each with its remedy.
 */
export function buildPlan(
  check: SshCheckResult,
  input: { name: string; port: number; version: string }
): SshPlan {
  const blocked: NonNullable<SshPlan['blocked']> = []
  if (check.hostKey?.state !== 'trusted')
    blocked.push({ name: 'Host key', remedy: 'Confirm the host key fingerprint first.' })
  if (check.auth !== 'ok')
    blocked.push({
      name: 'SSH login',
      remedy: check.copyId
        ? `Install your key on the machine: ${check.copyId}`
        : (check.detail ?? 'Mousse could not log in with a key or agent.')
    })
  if (check.enrolled)
    blocked.push({
      name: 'Already part of a device set',
      remedy: 'Revoke it from its current device set first.'
    })
  for (const item of check.prerequisites as SshPrerequisite[])
    if (!item.ok && !item.indeterminate)
      blocked.push({
        name: item.name,
        remedy: item.remedy ?? 'Fix this on the machine and check again.'
      })
  const installed = check.installed
  // An older CLI has no `--via`, `--headless`, `net routes` or saved add-on list: setup would get as
  // far as installing a service and then fail at the join.
  if (
    installed?.cli.owner === 'external' &&
    installed.cli.version &&
    input.version !== '0.0.0' &&
    isOlderVersion(installed.cli.version, input.version)
  )
    blocked.push({
      name: `Mousse on the machine (${installed.cli.version}) is older than this computer (${input.version})`,
      remedy: `Update Mousse on the machine to ${input.version} or newer, then check again.`
    })
  if (installed?.service.owner === 'external' && installed.service.state === 'stopped')
    blocked.push({
      name: 'The Mousse service on the machine is stopped',
      remedy:
        check.os === 'Darwin'
          ? 'Run on the machine: launchctl kickstart -k gui/$UID/com.ryspa.mousse.mms, then check again.'
          : 'Run on the machine: systemctl --user start mousse-mms, then check again.'
    })

  const steps: SshPlanStep[] = []
  const home = check.home ?? '~'
  const userName = check.resolved?.user ?? 'the user'
  if (!installed || installed.cli.owner === 'none') {
    steps.push({
      id: 'install',
      title: `Install Mousse ${input.version}`,
      detail: `Downloads ${assetName(input.version)} on the machine from the project’s GitHub release, checks it against the published SHA256SUMS, unpacks it to ${home}/${INSTALL_RELATIVE}/${input.version} and writes a launcher at ${home}/${LAUNCHER_RELATIVE}. The launcher sets ELECTRON_DISABLE_SANDBOX=1 because the service shows no windows. If the machine cannot reach GitHub, this computer downloads and verifies the file and sends it over SSH.`,
      command: `curl -fL -o ${assetName(input.version)} ${assetUrl(input.version)}`
    })
  }
  if (!installed || installed.service.owner === 'none') {
    steps.push({
      id: 'service',
      title: 'Install and start the Mousse service',
      detail: `Writes the systemd user unit ${home}/${UNIT_RELATIVE} and starts it. No sudo is used.`,
      command: 'mousse-cli service install --headless'
    })
    if (check.linger === 'no')
      steps.push({
        id: 'linger',
        title: 'Keep the service running after logout',
        detail: `Turns on lingering for ${userName}. If the machine refuses without an administrator, this step is skipped and you get the command to run yourself.`,
        command: `loginctl enable-linger ${userName}`
      })
  }
  steps.push(
    {
      id: 'join',
      title: `Join this computer’s devices as “${input.name}”`,
      detail:
        'Creates a one-time invitation, sends it to the machine over SSH (standard input, never a command argument) and lets the machine reach this computer through a temporary reverse tunnel for the join only.'
    },
    {
      id: 'addon',
      title: 'Turn on SSH access on the machine',
      detail: `The machine’s daemon listens on 127.0.0.1:${input.port}, reachable only through SSH, and advertises that route to your other devices.`,
      command: 'mousse-cli net transport configure ssh --settings-file <settings>'
    },
    {
      id: 'approval',
      title: 'Approve SSH for the machine on this computer',
      detail: `Saves the approval for ${check.resolved?.hostname ?? 'the machine'} with host key ${check.hostKey?.fingerprint ?? ''} and opens the first connection. Only an approval saved here lets Mousse run ssh to it.`
    },
    {
      id: 'undo',
      title: 'Undo later',
      detail:
        'Devices → the machine → Undo setup revokes the device and removes only what this setup installed. The machine’s Mousse data and identity are never deleted.'
    }
  )
  return { steps, ...(blocked.length ? { blocked } : {}) }
}

import type { EditorAskReply } from '../../shared/bridge/editorAsk'
import { editorSshProblemWords } from './editorSsh'
import type { EditorConnectionFailure, RemoteAskResult, RemoteOpenResult } from '../../shared/remoteEditor'

/**
 * Why an editor cannot open a folder of another computer, as the side card says it: one terse line and one
 * action. The longer words are a tooltip (`tip`) or sit behind the action (`steps`, "How to turn on"); the card
 * never shows a paragraph. Every state still names what to do, so none is a dead end.
 */

export type EditorHelpAction =
  /** Asks the computer to allow editor connections from this one. */
  | { kind: 'ask'; label: string }
  /** Opens the folder again. */
  | { kind: 'retry'; label: string }
  /** Opens Settings, Devices at that computer. */
  | { kind: 'devices'; label: string }

export interface EditorHelp {
  /** What is wrong, in one short line. */
  message: string
  /** Longer words, for a tooltip. */
  tip?: string
  /** What to do on the other computer, shown only after the person picks `stepsLabel`. */
  steps?: string
  stepsLabel?: string
  /** Something to copy and run or add by hand: a command, or the line for `~/.ssh/config`. Shown with the steps. */
  command?: { text: string; label: string }
  /** The one action; with `steps`, it follows them. */
  actions: EditorHelpAction[]
  /** Show the action next to the `stepsLabel` link instead of after it (the steps are a side path, not the way on). */
  stepsAlongside?: boolean
}

const retry: EditorHelpAction = { kind: 'retry', label: 'Retry' }

/** The words for a computer's system, from the platform it reported (`process.platform`). */
function system(platform: string | undefined): 'windows' | 'macos' | 'linux' | undefined {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return platform === 'linux' ? 'linux' : undefined
}

/** What to do on a computer that has no SSH server running, for its system. */
export function installSshServerWords(computer: string, platform: string | undefined): string {
  switch (system(platform)) {
    case 'windows':
      return `On ${computer}: install OpenSSH Server (Settings, System, Optional features), then start the OpenSSH SSH Server service.`
    case 'macos':
      return `On ${computer}: turn on Remote Login (System Settings, General, Sharing).`
    case 'linux':
      return `On ${computer}: install openssh-server and make sure it is running.`
    default:
      return `On ${computer}: install an SSH server and make sure it is running.`
  }
}

/** What to do when the SSH server is there but its host key cannot be read. */
function hostKeyWords(computer: string, platform: string | undefined): string {
  switch (system(platform)) {
    case 'windows':
      return `On ${computer}: start the OpenSSH SSH Server service once, so it creates its host keys.`
    case 'macos':
    case 'linux':
      return `On ${computer}: run "sudo ssh-keygen -A" so the SSH server has host keys, then restart it.`
    default:
      return `On ${computer}: make sure the SSH server has created its host keys.`
  }
}

/** Where this computer's public key goes on a computer, for its system. */
function keyWords(computer: string, platform: string | undefined, command: boolean): string {
  const where =
    system(platform) === 'windows'
      ? `add this computer's public key to authorized_keys on ${computer} (for an administrator account, C:\\ProgramData\\ssh\\administrators_authorized_keys)`
      : `add this computer's public key to ~/.ssh/authorized_keys on ${computer}`
  const first = where.charAt(0).toUpperCase() + where.slice(1)
  return command ? `${first}. This command does it if ${computer} accepts a password sign-in.` : `${first}.`
}

export interface EditorHelpInput {
  failure: EditorConnectionFailure
  /** The computer's name. */
  computer: string
  /** Its platform (`win32`, `darwin`, `linux`), when this computer knows it. */
  platform?: string
  /** What the other program printed (the last line `ssh` wrote). */
  message?: string
  /** For `key_refused`: the command that puts this computer's key on the other one. */
  command?: string
}

/** The state for one failure of the editor connection to `computer`. */
export function editorConnectionHelp({ failure, computer, platform, message, command }: EditorHelpInput): EditorHelp {
  switch (failure) {
    case 'offline':
      return { message: `${computer} offline`, actions: [retry] }
    case 'editor_off':
      return {
        message: `Editor connections off on ${computer}`,
        tip: 'Gives shell access',
        actions: [{ kind: 'ask', label: `Ask ${computer}` }]
      }
    case 'blocked':
      return { message: `Blocked by ${computer}`, tip: `Unblock this computer in Settings, Devices on ${computer}.`, actions: [retry] }
    case 'setting_off':
      return {
        message: `${computer} is not sharing`,
        tip: `On ${computer}, turn on "Let my other computers work on this computer's threads" in Settings, Devices.`,
        actions: [retry]
      }
    case 'capability':
      return {
        message: `Not allowed on ${computer}`,
        tip: 'Turn on Works on threads for this computer in Settings, Devices, on the computer that manages your devices.',
        actions: [{ kind: 'devices', label: 'Devices' }]
      }
    case 'net_off':
      return { message: `Mousse Net off on ${computer}`, tip: `Turn it on in Settings, Devices on ${computer}.`, actions: [retry] }
    case 'no_ssh_server':
      return {
        message: `No SSH server on ${computer}`,
        stepsLabel: 'How to turn on',
        steps: `${installSshServerWords(computer, platform)} Its files stay available in the Files panel.`,
        actions: [retry]
      }
    case 'no_host_key':
      return { message: `No SSH host key on ${computer}`, stepsLabel: 'How to fix', steps: hostKeyWords(computer, platform), actions: [retry] }
    case 'host_untrusted':
      return {
        message: `Windows can't vouch for SSH on ${computer}`,
        stepsLabel: 'How to fix',
        steps: `On ${computer}: use the OpenSSH Server from Windows' optional features, let only administrators change C:\\ProgramData\\ssh, and stop any other program that listens on port 22.`,
        actions: [retry]
      }
    case 'limit':
      return { message: `Too many connections to ${computer}`, tip: `Close an editor window connected to ${computer}.`, actions: [retry] }
    case 'rate_limited':
      return { message: `Too many tries on ${computer}`, tip: 'Wait a minute.', actions: [retry] }
    case 'unsupported':
      return { message: `${computer} needs a Mousse update`, tip: `Update Mousse on ${computer}.`, actions: [retry] }
    case 'timeout':
      return { message: `${computer} did not answer`, actions: [retry] }
    case 'far_end_error':
      return { message: `SSH on ${computer} failed`, tip: 'Check that the SSH server is running.', actions: [retry] }
    case 'key_refused':
      return {
        message: `${computer} did not accept this key`,
        stepsLabel: 'How to fix',
        steps: keyWords(computer, platform, Boolean(command)),
        ...(command ? { command: { text: command, label: 'Copy command' } } : {}),
        actions: [retry]
      }
    case 'ssh_failed':
      return { message: `Sign-in to ${computer} failed`, ...(message ? { tip: message } : {}), actions: [retry] }
    case 'access_lost':
    case 'protocol':
    case 'closed':
    case 'cancelled':
      return { message: `Connection to ${computer} ended`, actions: [retry] }
  }
}

/** The state for a refused open, or undefined when it is not one of the editor connection states. */
export function helpForOpenResult(
  result: Extract<RemoteOpenResult, { ok: false }>,
  computer: string,
  platform?: string
): EditorHelp | undefined {
  if (result.reason === 'connection' && result.failure)
    return editorConnectionHelp({
      failure: result.failure,
      computer,
      platform,
      ...(result.message ? { message: result.message } : {}),
      ...(result.command ? { command: result.command } : {})
    })
  if (result.reason === 'ssh_settings') {
    const words = editorSshProblemWords({ code: result.code ?? '', message: result.message ?? '' }, result.includeLine)
    return {
      message: 'Could not update ~/.ssh/config',
      stepsLabel: 'How to fix',
      steps: words,
      ...(result.includeLine ? { command: { text: result.includeLine, label: 'Copy line' } } : {}),
      actions: [retry]
    }
  }
  return undefined
}

/**
 * What the sign-in check found when it did not pass, shown after the editor started: advice and not a refusal, as
 * the check cannot tell a person who will type a password or touch a key from one who cannot sign in. No action:
 * the editor is already open and asks for what it needs.
 */
export function signInAdvice(
  advice: NonNullable<Extract<RemoteOpenResult, { ok: true }>['advice']>,
  computer: string,
  platform?: string
): EditorHelp {
  if (advice.failure === 'key_refused')
    return {
      message: `${computer} may ask for a key`,
      stepsLabel: 'How to fix',
      steps: keyWords(computer, platform, Boolean(advice.command)),
      ...(advice.command ? { command: { text: advice.command, label: 'Copy command' } } : {}),
      actions: []
    }
  return { message: 'Sign-in check failed', ...(advice.message ? { tip: advice.message } : {}), actions: [] }
}

/** How a connection that Mousse carries runs, for the small badge under the button. */
export function viaWords(via: { path: 'direct' | 'relay'; transport?: string }): string {
  if (via.path === 'relay') return 'Mousse relay'
  switch (via.transport) {
    case 'tailscale':
      return 'Tailscale'
    case 'cloudflared':
      return 'Cloudflare tunnel'
    case 'ssh':
      return 'SSH'
    case 'direct':
      return 'direct'
    default:
      return 'Mousse'
  }
}

/** The badge after an open: "via Mousse relay". */
export const openedWords = (via: { path: 'direct' | 'relay'; transport?: string }): string => `via ${viaWords(via)}`

/** What an Ask came to: one short state and the action that follows. */
export interface AskOutcome {
  message: string
  tip?: string
  command?: { text: string; label: string }
  steps?: string
  stepsLabel?: string
  stepsAlongside?: boolean
  actions: EditorHelpAction[]
}

/**
 * What to tell the person after asking `computer`. `self` is this computer's node id, for the command to run on
 * a computer that has no screen to show the question on (behind "No screen on <computer>?").
 */
export function askOutcomeWords(result: RemoteAskResult, computer: string, self?: string): AskOutcome {
  if (!result.ok) {
    const help = editorConnectionHelp({ failure: result.failure, computer })
    // Blocked, offline, switched off, too old: the same words as when the open was refused; never an Ask again.
    return { ...help, actions: help.actions.filter((action) => action.kind !== 'ask') }
  }
  return replyWords(result.reply, computer, self)
}

function replyWords(reply: EditorAskReply, computer: string, self?: string): AskOutcome {
  // A computer with no screen cannot show the question: its command is behind a link, not in the way.
  const noScreen = self
    ? {
        stepsLabel: `No screen on ${computer}?`,
        steps: 'Run this on it:',
        command: { text: `mousse-cli bridge limits ${self} --editor on`, label: 'Copy command' },
        stepsAlongside: true
      }
    : {}
  switch (reply.state) {
    case 'asked':
    case 'pending':
      return { message: 'Asked · waiting', ...noScreen, actions: [retry] }
    case 'already_on':
      return { message: `${computer} allows it`, actions: [{ kind: 'retry', label: 'Open' }] }
    case 'declined_recently':
      return { message: `${computer} said not now`, tip: `Ask again later, or turn it on in Settings, Devices on ${computer}.`, ...noScreen, actions: [retry] }
    case 'rate_limited':
      return { message: 'Asked too often', tip: `Ask again later, or turn it on in Settings, Devices on ${computer}.`, ...noScreen, actions: [retry] }
  }
}

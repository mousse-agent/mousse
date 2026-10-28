import type { EditorAskReply } from '../../shared/bridge/editorAsk'
import { editorSshProblemWords } from './editorSsh'
import type { EditorConnectionFailure, RemoteAskResult, RemoteOpenResult } from '../../shared/remoteEditor'

/**
 * Why an editor cannot open a folder of another computer, in plain words with the next step: one state for each
 * refusal of the connection (`shared/net/tunnel.ts`), for what the sign-in check found, and for the settings
 * Mousse keeps on this computer. Nothing here is a dead end: every state names what to do, and offers a button
 * where Mousse can do it.
 */

export type EditorHelpAction =
  /** Asks the computer to allow editor connections from this one. */
  | { kind: 'ask'; label: string }
  /** Opens the folder again. */
  | { kind: 'retry'; label: string }
  /** Opens Settings, Devices at that computer. */
  | { kind: 'devices'; label: string }

export interface EditorHelp {
  /** What is wrong, as a sentence. */
  message: string
  /** What to do about it, as a sentence. */
  next?: string
  /** Something to copy and run or add by hand: a command, or the line for `~/.ssh/config`. */
  command?: { text: string; label: string }
  /** What the other program printed, for a failure nothing here explains. */
  detail?: string
  actions: EditorHelpAction[]
}

const retry: EditorHelpAction = { kind: 'retry', label: 'Try again' }

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
      return `On ${computer}, install OpenSSH Server (Settings, System, Optional features), then start the OpenSSH SSH Server service.`
    case 'macos':
      return `On ${computer}, turn on Remote Login (System Settings, General, Sharing).`
    case 'linux':
      return `On ${computer}, install openssh-server and make sure it is running.`
    default:
      return `On ${computer}, install an SSH server and make sure it is running.`
  }
}

/** What to do when the SSH server is there but its host key cannot be read. */
function hostKeyWords(computer: string, platform: string | undefined): string {
  switch (system(platform)) {
    case 'windows':
      return `On ${computer}, start the OpenSSH SSH Server service once, so it creates its host keys.`
    case 'macos':
    case 'linux':
      return `On ${computer}, run "sudo ssh-keygen -A" so the SSH server has host keys, then restart it.`
    default:
      return `On ${computer}, make sure the SSH server has created its host keys.`
  }
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
      return { message: `${computer} is offline.`, next: 'Turn it on or reconnect it, then try again.', actions: [retry] }
    case 'editor_off':
      return {
        message: `Editor connections from this computer are off on ${computer}.`,
        next: `An editor connection gives shell access, so ${computer} has to allow it.`,
        actions: [{ kind: 'ask', label: `Ask ${computer}` }]
      }
    case 'blocked':
      return {
        message: `${computer} has blocked this computer.`,
        next: `Unblock this computer in Settings, Devices on ${computer}, then try again.`,
        actions: [retry]
      }
    case 'setting_off':
      return {
        message: `${computer} is not letting other computers work on its threads.`,
        next: `On ${computer}, turn on "Let my other computers work on this computer's threads" in Settings, Devices.`,
        actions: [retry]
      }
    case 'capability':
      return {
        message: `This computer is not allowed to work on ${computer}.`,
        next: 'Turn on Works on threads for this computer in Settings, Devices, on the computer that manages your devices.',
        actions: [retry, { kind: 'devices', label: 'Open Devices…' }]
      }
    case 'net_off':
      return {
        message: `Mousse Net is turned off on ${computer}.`,
        next: `Turn it on in Settings, Devices on ${computer}, then try again.`,
        actions: [retry]
      }
    case 'no_ssh_server':
      return {
        message: `${computer} has no SSH server running.`,
        next: `${installSshServerWords(computer, platform)} You can still browse and edit its files in the Files panel.`,
        actions: [retry]
      }
    case 'no_host_key':
      return {
        message: `Mousse cannot read the SSH host key of ${computer}.`,
        next: hostKeyWords(computer, platform),
        actions: [retry]
      }
    case 'host_untrusted':
      return {
        message: `Mousse cannot tell that the SSH server on ${computer} is the one Windows installed, so it does not vouch for it.`,
        next: `On ${computer}, use the OpenSSH Server from Windows' optional features, let only administrators change the folder C:\\ProgramData\\ssh, and stop any other program that listens on port 22.`,
        actions: [retry]
      }
    case 'limit':
      return {
        message: `This computer already has all the editor connections it may have on ${computer}.`,
        next: `Close an editor window that is connected to ${computer}, then try again.`,
        actions: [retry]
      }
    case 'rate_limited':
      return {
        message: `Editor connections to ${computer} are being opened too fast.`,
        next: 'Wait a minute, then try again.',
        actions: [retry]
      }
    case 'unsupported':
      return {
        message: `${computer} runs a version of Mousse that cannot carry editor connections.`,
        next: `Update Mousse on ${computer}, then try again.`,
        actions: [retry]
      }
    case 'timeout':
      return { message: `${computer} did not answer in time.`, next: 'Try again in a moment.', actions: [retry] }
    case 'far_end_error':
      return {
        message: `The SSH server on ${computer} ended the connection with an error.`,
        next: 'Check that it is running, then try again.',
        actions: [retry]
      }
    case 'key_refused':
      return {
        message: `The SSH server on ${computer} did not accept this computer's key.`,
        next: command
          ? 'Run this in a terminal on this computer to add the key, then try again.'
          : `Add this computer's public key (~/.ssh/id_ed25519.pub) to ~/.ssh/authorized_keys on ${computer}, then try again.`,
        ...(command ? { command: { text: command, label: 'Copy command' } } : {}),
        actions: [retry]
      }
    case 'ssh_failed':
      return {
        message: `Signing in to ${computer} over SSH did not work.`,
        next: 'Check the SSH server there, then try again.',
        ...(message ? { detail: message } : {}),
        actions: [retry]
      }
    case 'access_lost':
    case 'protocol':
    case 'closed':
    case 'cancelled':
      return { message: `The editor connection to ${computer} ended.`, next: 'Try again.', actions: [retry] }
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
    const text = editorSshProblemWords({ code: result.code ?? '', message: result.message ?? '' }, result.includeLine)
    return {
      message: text,
      next: result.includeLine ? undefined : 'Fix that, then try again.',
      ...(result.includeLine ? { command: { text: result.includeLine, label: 'Copy line' } } : {}),
      actions: [retry]
    }
  }
  return undefined
}

/** How a connection that Mousse carries runs, for "Opening on Computer B through Mousse relay". */
export function viaWords(via: { path: 'direct' | 'relay'; transport?: string }): string {
  if (via.path === 'relay') return 'Mousse relay'
  switch (via.transport) {
    case 'tailscale':
      return 'Tailscale'
    case 'cloudflared':
      return 'a Cloudflare tunnel'
    case 'ssh':
      return 'SSH'
    case 'direct':
      return 'a direct connection'
    default:
      return 'Mousse'
  }
}

/** The line under the button once the editor was started. */
export function openedWords(computer: string, via?: { path: 'direct' | 'relay'; transport?: string }): string {
  return via ? `Opening on ${computer} through ${viaWords(via)}.` : `Opening on ${computer}.`
}

/** What an Ask came to, as a sentence, with whether it is worth offering the same button again. */
export interface AskOutcome {
  message: string
  next?: string
  /** A command for a computer with no screen, to run on that computer. */
  command?: { text: string; label: string }
  actions: EditorHelpAction[]
}

/**
 * What to tell the person after asking `computer`. `self` is this computer's node id, for the command to run on a
 * computer that has no screen to show the question on.
 */
export function askOutcomeWords(result: RemoteAskResult, computer: string, self?: string): AskOutcome {
  if (!result.ok) {
    const help = editorConnectionHelp({ failure: result.failure, computer })
    // Blocked, offline, switched off, too old: the same words as when the open was refused; a blocked computer
    // is not offered the Ask again.
    return { message: help.message, next: help.next, actions: help.actions.filter((action) => action.kind !== 'ask') }
  }
  return replyWords(result.reply, computer, self)
}

function replyWords(reply: EditorAskReply, computer: string, self?: string): AskOutcome {
  const headless =
    self && reply.state !== 'already_on'
      ? { text: `mousse-cli bridge limits ${self} --editor on`, label: 'Copy command' }
      : undefined
  const noScreen = `If ${computer} has no screen, run this on it:`
  switch (reply.state) {
    case 'asked':
      return {
        message: `Asked ${computer}.`,
        next: `When someone there allows it, open the folder again.${headless ? ` ${noScreen}` : ''}`,
        ...(headless ? { command: headless } : {}),
        actions: [retry]
      }
    case 'pending':
      return {
        message: `${computer} has not answered your ask yet.`,
        next: `When someone there allows it, open the folder again.${headless ? ` ${noScreen}` : ''}`,
        ...(headless ? { command: headless } : {}),
        actions: [retry]
      }
    case 'already_on':
      return { message: `${computer} already allows editor connections from this computer.`, next: 'Open the folder again.', actions: [retry] }
    case 'declined_recently':
      return {
        message: `${computer} said not now.`,
        next: `Ask again later, or turn it on in Settings, Devices on ${computer}.${headless ? ` ${noScreen}` : ''}`,
        ...(headless ? { command: headless } : {}),
        actions: [retry]
      }
    case 'rate_limited':
      return {
        message: `You have asked ${computer} a few times already.`,
        next: `Ask again later, or turn it on in Settings, Devices on ${computer}.${headless ? ` ${noScreen}` : ''}`,
        ...(headless ? { command: headless } : {}),
        actions: [retry]
      }
  }
}

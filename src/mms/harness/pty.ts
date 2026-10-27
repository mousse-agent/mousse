import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

/**
 * Sign-in commands that print their link or device code only to a terminal run here, in a
 * pseudo-terminal from `node-pty`. `node-pty` has no prebuild for some platforms (Windows arm64)
 * and may not load under a system Node, so callers check `ptyAvailable()` and offer another
 * sign-in when it is false.
 */

/** The slice of a `node-pty` terminal the runner uses. */
export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  kill(signal?: string): void
  /** Types into the terminal (`node-pty` has it; a stand-in that never reads input may leave it out). */
  write?(data: string): void
}

export type PtySpawn = (command: string, args: string[], options: { name: string; cols: number; rows: number; cwd?: string; env: NodeJS.ProcessEnv }) => PtyProcess

let loaded: { spawn?: PtySpawn; error?: string } | undefined

function load(): { spawn?: PtySpawn; error?: string } {
  if (loaded) return loaded
  try {
    const pty = createRequire(import.meta.url)('node-pty') as { spawn?: PtySpawn }
    loaded = typeof pty?.spawn === 'function' ? { spawn: pty.spawn } : { error: 'node-pty loaded without spawn' }
  } catch (error) {
    loaded = { error: error instanceof Error ? error.message : String(error) }
  }
  return loaded
}

/** Kills `pid` and its children (a pseudo-terminal's command leads its own process group). */
function killPidTree(pid: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/** Whether a sign-in can run in a pseudo-terminal here. */
export function ptyAvailable(): boolean {
  return Boolean(load().spawn)
}

/** The longest transcript kept; older output is dropped first. */
export const PTY_TRANSCRIPT_BYTES = 16 * 1024

export interface PtyRun {
  /** Exit code 0 means the command succeeded. */
  readonly done: Promise<{ exitCode: number; transcript: string }>
  /** Types `data` into the command's terminal (a pasted code, then `\r` for Enter). */
  write(data: string): void
  /** Kills the command and everything it started. */
  cancel(): void
}

/**
 * Runs `command args` in a pseudo-terminal (80×24 unless `cols` says otherwise). `onOutput` sees
 * the transcript so far (capped) after each chunk. `spawn` replaces `node-pty` (tests).
 */
export function runInPty(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; cols?: number; onOutput?: (transcript: string) => void; spawn?: PtySpawn }
): PtyRun {
  const spawn = options.spawn ?? load().spawn
  if (!spawn) throw new Error('This computer cannot run a sign-in terminal here.')
  const terminal = spawn(command, args, { name: 'xterm-256color', cols: options.cols ?? 80, rows: 24, env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) })
  let transcript = ''
  let cancelled = false
  let exited = false
  const done = new Promise<{ exitCode: number; transcript: string }>((resolve) => {
    terminal.onData((data) => {
      transcript = (transcript + data).slice(-PTY_TRANSCRIPT_BYTES)
      try {
        options.onOutput?.(transcript)
      } catch {
        /* a listener never breaks the sign-in */
      }
    })
    terminal.onExit(({ exitCode }) => {
      exited = true
      resolve({ exitCode: cancelled ? -1 : exitCode, transcript })
    })
  })
  return {
    done,
    write: (data) => {
      if (exited || cancelled) return
      try {
        terminal.write?.(data)
      } catch {
        /* the command ended while the text was on its way */
      }
    },
    cancel: () => {
      cancelled = true
      // The command may have started a browser helper or a server: the whole tree goes.
      killPidTree(terminal.pid)
      try {
        terminal.kill()
      } catch {
        /* already gone */
      }
    }
  }
}

const URL_PATTERN = /https:\/\/[^\s"'<>()\x1b]+/g
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const CODE_PATTERN = /\b(?:code|user code|device code)\b[^A-Z0-9]{0,40}([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\b/i
/** Claude Code asks for the code the browser shows when its own callback cannot be reached. */
const PASTE_PROMPT = /paste code here/i

/** The text of a terminal transcript: control sequences removed. */
export function terminalText(transcript: string): string {
  return transcript.replace(ANSI, '')
}

/** Every https link a terminal transcript printed, in order. */
export function transcriptLinks(transcript: string): string[] {
  return [...terminalText(transcript).matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;:]+$/, ''))
}

/** The sign-in link, device code and paste prompt a terminal sign-in printed, terminal codes removed. */
export function signInPrompts(transcript: string): { url?: string; userCode?: string; pastePrompt?: true } {
  const text = terminalText(transcript)
  const urls = transcriptLinks(transcript)
  const code = CODE_PATTERN.exec(text)?.[1] ?? (urls[0] ? new URL(urls[0]).searchParams.get('user_code') ?? undefined : undefined)
  return { ...(urls[0] ? { url: urls[0] } : {}), ...(code ? { userCode: code } : {}), ...(PASTE_PROMPT.test(text) ? { pastePrompt: true as const } : {}) }
}

/**
 * `text` with what a sign-in must not leave behind removed: each of `secrets` (a pasted code) and
 * any `code=`, `user_code=`, `state=` or token value of a link. Every message made from a sign-in's
 * output or failure goes through it; the transcript itself is never logged or stored.
 */
export function redactSignIn(text: string, secrets: readonly string[] = []): string {
  let redacted = text
  for (const secret of secrets) if (secret.length >= 3) redacted = redacted.split(secret).join('[redacted]')
  return redacted.replace(/\b(code|user_code|state|code_verifier|access_token|refresh_token)=[^\s&"'<>)]+/gi, '$1=[redacted]')
}

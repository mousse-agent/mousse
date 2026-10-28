import type { Readable, Writable } from 'node:stream'
import type { SftpPaths } from './sftp/paths'

/**
 * What the endpoint needs from the operating system of the computer it runs on, and nothing else. Everything
 * above this file (the SSH server, authentication, channels, forwards, SFTP, the rules for ending a connection)
 * is the same on every system; the way a program is started, the environment it gets and the way everything a
 * device started is stopped are not, so each system has a host.
 *
 * `unixHost.ts` is the host of Linux and macOS. A Windows host (a helper program named `sshd.exe` for every
 * session, which VS Code looks for among its ancestors, and one Job object per device to stop everything at
 * once) is a second implementation of this interface and changes nothing above it: until it exists, `processHost`
 * returns nothing for Windows, the endpoint is unavailable there, and a Windows computer keeps carrying editor
 * connections to its own OpenSSH server.
 */

/** What a client asked for in one session channel. */
export interface SessionRequest {
  /** The command of an `exec` request, or undefined for a `shell` request (a login shell). */
  command: string | undefined
  /** The terminal of a `pty-req`, if there was one. */
  pty?: { cols: number; rows: number; term: string }
  /** Variables the client set that passed the allow-list. */
  requested: Record<string, string>
  /** `<client address> <client port> <server address> <server port>` for `SSH_CONNECTION`. */
  sshConnection: string
  /** The device's scope token: the marker every program started for the device carries. */
  scope: string
}

/** The exit of a program: its status, or the signal that ended it. */
export interface SessionExit {
  code: number | null
  signal: string | null
}

/** One program started for a session. Under a terminal `errors` is absent: standard error is on the terminal. */
export interface SessionProcess {
  /** What the client sends. */
  input: Writable
  /** Standard output, or the terminal's output. */
  output: Readable
  errors?: Readable
  /** The program ended. */
  onExit(listener: (exit: SessionExit) => void): void
  /** The program ended and everything it wrote has been read. */
  onClose(listener: () => void): void
  /** The program could not be started. */
  onError(listener: (error: Error) => void): void
  /** The terminal changed size. Nothing without one. */
  resize(columns: number, rows: number): void
  /** An SSH `signal` request (a name without `SIG`). Names outside OpenSSH's list are ignored. */
  signal(name: string): void
  /**
   * The connection or the channel ended in the ordinary way, as `sshd` handles it: a terminal is hung up (the
   * program gets SIGHUP), a program without one has its pipes closed (it ends when it next writes, or reads
   * the end of its input), and nothing else is stopped. A server the program started keeps running.
   */
  hangUp(): void
  /** Stops the program and its process group now. */
  kill(): void
}

export interface ProcessHost {
  readonly kind: 'unix' | 'windows'
  /** The login of the user the daemon runs as: the only user name the endpoint accepts. */
  readonly user: string
  readonly home: string
  /** How SFTP paths name places on this system. */
  readonly sftp: { paths: SftpPaths; listRoots?: () => Promise<string[]> }
  /** Whether a session may have a terminal. */
  terminals(): boolean
  /** Starts the program of a session, in a clean environment. Rejects when it cannot be started at all. */
  start(request: SessionRequest): Promise<SessionProcess>
  /**
   * Stops everything started for `scope`, whether or not its session still exists, and resolves when none is
   * found. It never blocks the thread: the lists are read and the signals sent between turns of the event loop.
   */
  killScope(scope: string): Promise<void>
  /**
   * Stops every program that carries the marker of a device `isAllowed` refuses, found by reading the marker of
   * the processes that exist: it needs no list of devices, so a device that was revoked, one whose last session
   * ended long ago and servers left from before the daemon restarted are all found. Never stops the daemon's own
   * process or anything it started. Resolves with how many processes were signalled.
   */
  sweep(isAllowed: (scope: string) => boolean): Promise<number>
  /** The scopes that have a session program running that the host started and still tracks (tests clean up with it). */
  scopes(): string[]
}

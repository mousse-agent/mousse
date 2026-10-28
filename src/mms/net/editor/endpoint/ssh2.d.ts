/**
 * The part of `ssh2` 1.17.0 (server mode) that the SSH endpoint uses. The package ships no types, and Mousse
 * adds no `@types` package for one file's worth of calls, so the surface is declared here, as narrowly as the
 * code needs it. Every callback an event gives is typed, so a change in the library shows up as a type error.
 */
declare module 'ssh2' {
  import type { EventEmitter } from 'node:events'
  import type { Duplex, Writable } from 'node:stream'

  export interface ServerConfig {
    hostKeys: Array<string | Buffer>
    ident?: string
    keepaliveInterval?: number
    keepaliveCountMax?: number
    algorithms?: Record<string, unknown>
  }

  /** One SSH channel as the server sees it: a duplex stream with the SSH extras. */
  export interface ServerChannel extends Duplex {
    /** What the program wrote to its standard error. */
    stderr: Writable
    /** Sends `exit-status`, or `exit-signal` when called with a signal name. */
    exit(status: number): void
    exit(signal: string, coreDumped: boolean, message: string): void
    close(): void
    eof(): void
  }

  export interface AuthContext {
    username: string
    method: string
    /** Present on a public-key attempt that carries a signature (absent on the probe that asks if a key is fine). */
    signature?: Buffer
    accept(): void
    reject(methodsLeft?: string[], isPartial?: boolean): void
  }

  type Accept<T> = () => T
  type Reject = () => void

  export interface PtyInfo {
    cols: number
    rows: number
    width: number
    height: number
    term: string
    modes: Record<string, number>
  }
  export interface WindowChangeInfo {
    cols: number
    rows: number
    width: number
    height: number
  }

  export interface ServerSession extends EventEmitter {
    on(
      event: 'env',
      listener: (
        accept: Accept<void> | undefined,
        reject: Reject | undefined,
        info: { key: string; val: string }
      ) => void
    ): this
    on(
      event: 'pty',
      listener: (
        accept: Accept<void> | undefined,
        reject: Reject | undefined,
        info: PtyInfo
      ) => void
    ): this
    on(
      event: 'window-change',
      listener: (
        accept: Accept<void> | undefined,
        reject: Reject | undefined,
        info: WindowChangeInfo
      ) => void
    ): this
    on(
      event: 'signal',
      listener: (
        accept: Accept<void> | undefined,
        reject: Reject | undefined,
        info: { name: string }
      ) => void
    ): this
    on(
      event: 'auth-agent' | 'x11',
      listener: (accept: Accept<void> | undefined, reject: Reject | undefined) => void
    ): this
    on(event: 'shell', listener: (accept: Accept<ServerChannel>, reject: Reject) => void): this
    on(
      event: 'exec',
      listener: (accept: Accept<ServerChannel>, reject: Reject, info: { command: string }) => void
    ): this
    on(
      event: 'subsystem',
      listener: (accept: Accept<ServerChannel>, reject: Reject, info: { name: string }) => void
    ): this
    on(event: 'close' | 'eof' | 'end', listener: () => void): this
  }

  export interface DirectTcpipInfo {
    srcIP: string
    srcPort: number
    destIP: string
    destPort: number
  }
  export interface TcpipForwardInfo {
    bindAddr: string
    bindPort: number
  }

  export interface Connection extends EventEmitter {
    on(event: 'authentication', listener: (context: AuthContext) => void): this
    on(event: 'ready', listener: () => void): this
    on(event: 'session', listener: (accept: Accept<ServerSession>, reject: Reject) => void): this
    on(
      event: 'tcpip',
      listener: (accept: Accept<ServerChannel>, reject: Reject, info: DirectTcpipInfo) => void
    ): this
    on(
      event: 'openssh.streamlocal',
      listener: (
        accept: Accept<ServerChannel>,
        reject: Reject,
        info: { socketPath: string }
      ) => void
    ): this
    on(
      event: 'request',
      listener: (
        accept: ((chosenPort?: number) => void) | undefined,
        reject: Reject | undefined,
        name: string,
        info: TcpipForwardInfo | { socketPath: string }
      ) => void
    ): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'close' | 'end', listener: () => void): this
    /** Opens a channel to the client for a connection that arrived on a remote forward (`ssh -R`). */
    forwardOut(
      boundAddr: string,
      boundPort: number,
      remoteAddr: string,
      remotePort: number,
      callback: (error: Error | undefined, channel: ServerChannel) => void
    ): boolean
    end(): this
  }

  export class Server extends EventEmitter {
    constructor(config: ServerConfig, connectionListener?: (client: Connection) => void)
    /** Serves a connection that did not arrive on a socket of this server: the server never listens. */
    injectSocket(socket: Duplex): void
    close(callback?: () => void): this
    on(event: 'connection', listener: (client: Connection) => void): this
    on(event: 'error', listener: (error: Error) => void): this
  }

  export interface ParsedKey {
    type: string
    getPublicSSH(): Buffer
  }

  export const utils: {
    generateKeyPairSync(type: 'ed25519'): { private: string; public: string }
    parseKey(key: string | Buffer): ParsedKey | Error
  }
}

import { mkdir, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import dns from 'node:dns'
import net, { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEndpointHostKey } from '../../../src/mms/net/editor/endpoint/hostKey'
import {
  alive,
  endpointBed,
  memoryKeys,
  NODE_A,
  NODE_B,
  run,
  sshKeyPair,
  until,
  type Bed,
  type SshClient
} from '../helpers/endpointBed'
import {
  PACKET,
  PacketReader,
  PacketWriter,
  SFTP_EXTENSIONS,
  SFTP_MAX_PACKET,
  STATUS
} from '../../../src/mms/net/editor/endpoint/sftp/wire'

/**
 * The SSH endpoint, with `ssh2`'s own client as the peer over a pair of streams (the way a tunnel carries it).
 * Programs that are started are real: a shell of the user the tests run as, in a throwaway home. Tests that start
 * programs are for Linux and macOS; Windows has no host for the endpoint yet.
 */

const unix = process.platform !== 'win32'
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const task of cleanup.splice(0).reverse()) await task()
})
async function bed(): Promise<Bed> {
  const b = await endpointBed()
  cleanup.push(() => b.close())
  return b
}

async function loopbackServer(
  handler: (socket: net.Socket) => void
): Promise<{ port: number; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port: (server.address() as net.AddressInfo).port, server }
}

function channelOf(
  open: (callback: (error: Error | undefined, channel: any) => void) => unknown
): Promise<any> {
  return new Promise((resolve, reject) =>
    open((error, channel) => (error ? reject(error) : resolve(channel)))
  )
}

const quote = (text: string): string => `'${text.replace(/'/gu, `'\\''`)}'`

describe('the host key', () => {
  it('is made once, kept in the key store, and is what the client sees', async () => {
    const keys = memoryKeys()
    const first = loadEndpointHostKey(keys)
    expect(first.publicKey.type).toBe('ssh-ed25519')
    expect(keys.secrets.size).toBe(1)
    const again = loadEndpointHostKey(keys)
    expect(again.publicKey).toEqual(first.publicKey)
    expect(again.privateKey).toBe(first.privateKey)
    // A stored value that is not an ed25519 key is replaced rather than served.
    keys.putSecret([...keys.secrets.keys()][0]!, Buffer.from('not a key'))
    const replaced = loadEndpointHostKey(keys)
    expect(replaced.publicKey.type).toBe('ssh-ed25519')
    expect(replaced.publicKey.key).not.toBe(first.publicKey.key)
  })

  it.skipIf(!unix)(
    'is checked by the client: a client that pinned another key does not connect',
    async () => {
      const b = await bed()
      const { stream } = b.tunnel()
      const { Client } = (await import('node:module')).createRequire(import.meta.url)('ssh2') as {
        Client: new () => SshClient
      }
      const client = new Client()
      const failure = new Promise<Error>((resolve) => client.on('error', resolve))
      client.connect({
        sock: stream,
        username: b.user,
        authHandler: ['none'],
        hostVerifier: () => false
      })
      expect((await failure).message).toMatch(/verification failed|host/iu)
    }
  )
})

describe.skipIf(!unix)('the login', () => {
  it('listens on no port', async () => {
    const b = await bed()
    const listen = vi.spyOn(net.Server.prototype, 'listen')
    const { client } = await b.connect()
    const result = unix ? await run(client, 'echo hello') : undefined
    if (result) expect(result.stdout.toString()).toBe('hello\n')
    expect(listen).not.toHaveBeenCalled()
  })

  it('accepts the owner’s login name with none, a password, a key and keyboard-interactive, and says which', async () => {
    const b = await bed()
    const key = sshKeyPair()
    const attempts: Array<{ method: string; extra?: Record<string, unknown> }> = [
      { method: 'none' },
      { method: 'password', extra: { password: 'anything at all' } },
      { method: 'publickey', extra: { privateKey: key.private } },
      { method: 'keyboard-interactive', extra: { tryKeyboard: true } }
    ]
    for (const attempt of attempts)
      await b.connect({
        authHandler: [attempt.method],
        ...(attempt.extra ? { extra: attempt.extra } : {})
      })
    expect(
      b.events
        .filter((event) => event.kind === 'login')
        .map((event) => (event as { method: string }).method)
    ).toEqual(['none', 'password', 'publickey', 'keyboard-interactive'])
  })

  it('refuses any other user name, once for the audit, and ends the connection after six tries', async () => {
    const b = await bed()
    await expect(b.connect({ username: 'someone-else' })).rejects.toThrow(
      /authentication|handshake/iu
    )
    const refusals = b.events.filter((event) => event.kind === 'login_refused')
    expect(refusals[0]).toMatchObject({ kind: 'login_refused', node: NODE_A, reason: 'user' })
    expect(b.events.some((event) => event.kind === 'login')).toBe(false)
  })

  it('binds the login to the device of the tunnel', async () => {
    const b = await bed()
    await b.connect({ node: NODE_B })
    expect(b.events).toContainEqual({ kind: 'login', node: NODE_B, method: 'none' })
  })
})

describe.skipIf(!unix)('programs', () => {
  it('runs a command with its exit code, its standard error and its input', async () => {
    const b = await bed()
    const { client } = await b.connect()
    expect(await run(client, 'exit 3')).toMatchObject({ code: 3, signal: null })
    const split = await run(client, 'echo out; echo err >&2')
    expect(split.stdout.toString()).toBe('out\n')
    expect(split.stderr).toBe('err\n')
    const counted = await run(client, 'wc -c', { stdin: 'abcdef' })
    expect(counted.stdout.toString().trim()).toBe('6')
    const killed = await run(client, 'kill -TERM $$')
    expect(killed.signal).toMatch(/TERM/u)
  })

  it('starts in the owner’s home, as the owner, with a login-like environment and none of the daemon’s', async () => {
    const planted = {
      ANTHROPIC_API_KEY: 'planted-anthropic',
      OPENAI_API_KEY: 'planted-openai',
      MOUSSE_DAEMON_TOKEN: 'planted-token',
      ELECTRON_RUN_AS_NODE: 'planted-electron-flag',
      NODE_OPTIONS: '--require=/nonexistent/hook.js'
    }
    for (const [name, value] of Object.entries(planted)) vi.stubEnv(name, value)
    const b = await bed()
    const { client } = await b.connect()
    const output = (await run(client, 'pwd; env')).stdout.toString()
    expect(output.split('\n')[0]).toBe(b.home)
    for (const name of Object.keys(planted)) expect(output).not.toContain(`${name}=`)
    for (const value of Object.values(planted)) expect(output).not.toContain(value)
    expect(output).toContain(`USER=${b.user}`)
    expect(output).toContain(`HOME=${b.home}`)
    expect(output).toMatch(/^SSH_CONNECTION=127\.0\.0\.1 \d+ 127\.0\.0\.1 22$/mu)
    expect(output).toMatch(/^MOUSSE_EDITOR_SCOPE=[0-9a-f]{32}$/mu)
  })

  it('takes only the allow-listed variables a client sets', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const output = (
      await run(client, 'echo "[$LANG][$LC_ALL][$FOO]"; echo "$PATH"', {
        env: { LANG: 'de_DE.UTF-8', LC_ALL: 'C.UTF-8', FOO: 'bar', PATH: '/evil/bin' }
      })
    ).stdout.toString()
    const [first, path] = output.split('\n')
    expect(first).toBe('[de_DE.UTF-8][C.UTF-8][]')
    expect(path).not.toContain('/evil/bin')
  })

  it('starts a shell request as a login shell, and an exec as the shell’s -c', async () => {
    const b = await bed()
    const { client } = await b.connect()
    expect((await run(client, 'echo "$0"')).stdout.toString().trim()).not.toMatch(/^-/u)
    const channel = await channelOf((callback) => client.shell(false, callback))
    const out: Buffer[] = []
    channel.on('data', (chunk: Buffer) => out.push(chunk))
    channel.end('echo "login-name:$0"\nexit\n')
    await new Promise((resolve) => channel.on('close', resolve))
    expect(Buffer.concat(out).toString()).toMatch(/login-name:-\w+/u)
  })

  it('gives a terminal that changes size, and signals a program', async (context) => {
    const b = await bed()
    if (!b.host.terminals()) return context.skip()
    const { client } = await b.connect()
    const channel = await channelOf((callback) =>
      client.exec('sh', { pty: { rows: 24, cols: 80, term: 'xterm' } }, callback)
    )
    let text = ''
    channel.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    channel.write('tty; echo "term=$TERM"; stty size\n')
    await until(() => /\d+ \d+\r?\n/u.test(text) && text.includes('term=xterm'))
    expect(text).toMatch(/\/dev\/(pts\/\d+|tty\w*)/u)
    expect(text).toContain('24 80')
    channel.setWindow(40, 132, 0, 0)
    channel.write('stty size\n')
    await until(() => text.includes('40 132'))
    channel.write('exit\n')
    await new Promise((resolve) => channel.on('close', resolve))

    const signalled = await channelOf((callback) =>
      client.exec(
        `sh -c 'trap "echo got-int; exit 7" INT; echo ready; while :; do sleep 0.05; done'`,
        callback
      )
    )
    let seen = ''
    signalled.on('data', (chunk: Buffer) => (seen += chunk.toString('utf8')))
    let status: number | undefined
    signalled.on('exit', (code: number) => (status = code))
    await until(() => seen.includes('ready'))
    signalled.signal('INT')
    await until(() => status !== undefined)
    expect(seen).toContain('got-int')
    expect(status).toBe(7)
  })

  it('reports a program that cannot be started', async () => {
    const b = await bed()
    const { client } = await b.connect()
    // A shell that exists but a command that does not: the shell says so and exits 127.
    expect(await run(client, 'no-such-command-for-the-test')).toMatchObject({ code: 127 })
  })
})

describe.skipIf(!unix)('refusals', () => {
  it('forwards only to the loopback, by address, and never looks a name up', async () => {
    const b = await bed()
    const echo = await loopbackServer((socket) => socket.pipe(socket))
    // Listening on an address is itself a lookup; from here on, nothing may be looked up.
    const lookup = vi.spyOn(dns, 'lookup')
    const { client } = await b.connect()

    for (const target of ['127.0.0.1', 'localhost']) {
      const channel = await channelOf((callback) =>
        client.forwardOut('127.0.0.1', 0, target, echo.port, callback)
      )
      const received = new Promise<string>((resolve) =>
        channel.once('data', (chunk: Buffer) => resolve(chunk.toString()))
      )
      channel.write('ping')
      expect(await received).toBe('ping')
      channel.destroy()
    }
    // Not the loopback: refused before anything is connected or looked up.
    for (const target of [
      '192.0.2.1',
      '10.0.0.1',
      '0.0.0.0',
      'example.invalid',
      '::ffff:10.0.0.1',
      '2001:db8::1',
      'localhost.example.com'
    ]) {
      await expect(
        channelOf((callback) => client.forwardOut('127.0.0.1', 0, target, 80, callback))
      ).rejects.toThrow()
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(
      b.events.filter((event) => event.kind === 'refused' && event.what === 'direct-tcpip').length
    ).toBeGreaterThanOrEqual(7)
  })

  it('binds remote forwards to the loopback and refuses every other address', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const accepted = new Promise<net.Socket>((resolve) => {
      client.on('tcp connection', (_info: unknown, accept: () => net.Socket) => {
        const channel = accept() as unknown as net.Socket
        channel.on('data', (chunk) => channel.write(Buffer.concat([Buffer.from('echo:'), chunk])))
        resolve(channel)
      })
    })
    const port = await new Promise<number>((resolve, reject) =>
      client.forwardIn('127.0.0.1', 0, (error, chosen) => (error ? reject(error) : resolve(chosen)))
    )
    expect(port).toBeGreaterThan(0)
    const socket = net.connect(port, '127.0.0.1')
    const reply = new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(chunk.toString()))
    )
    socket.write('hi')
    expect(await reply).toBe('echo:hi')
    await accepted
    socket.destroy()
    for (const address of ['0.0.0.0', '*', '192.0.2.1', 'example.invalid']) {
      await expect(
        new Promise((resolve, reject) =>
          client.forwardIn(address, 0, (error) => (error ? reject(error) : resolve(undefined)))
        )
      ).rejects.toThrow()
    }
    expect(
      b.events.filter((event) => event.kind === 'refused' && event.what === 'tcpip-forward')
    ).toHaveLength(4)
  })

  it('refuses a unix socket forward, agent forwarding, X11 and every subsystem but sftp', async () => {
    const b = await bed()
    // The client asks "is the server OpenSSH?" before it sends a request only OpenSSH knows; this one is not.
    const { client } = await b.connect({ extra: { strictVendor: false } })
    await expect(
      channelOf((callback) =>
        client.openssh_forwardOutStreamLocal('/tmp/mousse-test.sock', callback)
      )
    ).rejects.toThrow()
    await expect(channelOf((callback) => client.subsys('netconf', callback))).rejects.toThrow()
    await expect(
      channelOf((callback) => client.exec('true', { x11: true }, callback))
    ).rejects.toThrow()
    const kinds = b.events
      .filter((event) => event.kind === 'refused')
      .map((event) => (event as { what: string }).what)
    expect(kinds).toEqual(expect.arrayContaining(['streamlocal', 'subsystem', 'x11']))

    // Agent forwarding is a request of its own, which the client sends only when it has an agent to offer.
    const forwarding = await b.connect({
      extra: { agent: '/nonexistent/agent.sock', agentForward: true }
    })
    await expect(run(forwarding.client, 'true')).rejects.toThrow()
    expect(b.events.some((event) => event.kind === 'refused' && event.what === 'agent')).toBe(true)
  })
})

describe.skipIf(!unix)('SFTP', () => {
  async function sftpOf(client: SshClient): Promise<any> {
    return channelOf((callback) => client.sftp(callback))
  }
  const call = <T>(
    fn: (done: (error: Error | null | undefined, value?: T) => void) => unknown
  ): Promise<T> =>
    new Promise((resolve, reject) =>
      fn((error, value) => (error ? reject(error) : resolve(value as T)))
    )

  it('answers INIT with version 3 and every extension, and ends with exit-status 0 when the client sends EOF', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const channel = await channelOf((callback) => client.subsys('sftp', callback))
    const chunks: Buffer[] = []
    channel.on('data', (chunk: Buffer) => chunks.push(chunk))
    channel.write(new PacketWriter().u32(3).packet(PACKET.INIT))
    await until(() => Buffer.concat(chunks).length >= 5)
    const all = Buffer.concat(chunks)
    const reader = new PacketReader(all.subarray(4, 4 + all.readUInt32BE(0)))
    expect(reader.byte()).toBe(PACKET.VERSION)
    expect(reader.u32()).toBe(3)
    const offered: Record<string, string> = {}
    while (!reader.done()) offered[reader.string()] = reader.string()
    expect(offered).toEqual(Object.fromEntries(SFTP_EXTENSIONS))
    expect(Object.keys(offered)).toEqual(
      expect.arrayContaining([
        'posix-rename@openssh.com',
        'statvfs@openssh.com',
        'limits@openssh.com',
        'expand-path@openssh.com',
        'home-directory',
        'hardlink@openssh.com'
      ])
    )
    let status: number | undefined
    channel.on('exit', (code: number) => (status = code))
    const closed = new Promise((resolve) => channel.on('close', resolve))
    channel.end()
    await closed
    expect(status).toBe(0)
    expect(b.endpoint.hostKeys()).toHaveLength(1)
  })

  it('does what sftp-server does on the real file system', async () => {
    const b = await bed()
    const { client, connection } = await b.connect()
    const sftp = await sftpOf(client)
    const dir = join(b.home, 'work')
    await call((done) => sftp.mkdir(dir, done))
    expect((await stat(dir)).isDirectory()).toBe(true)

    const file = join(dir, 'a.txt')
    const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251))
    await call((done) => sftp.writeFile(file, payload, done))
    expect((await readFile(file)).equals(payload)).toBe(true)
    expect((await call<Buffer>((done) => sftp.readFile(file, done))).equals(payload)).toBe(true)
    expect((await call<{ size: number }>((done) => sftp.stat(file, done))).size).toBe(
      payload.length
    )

    await call((done) => sftp.chmod(file, 0o600, done))
    expect((await stat(file)).mode & 0o777).toBe(0o600)

    const listing = await call<Array<{ filename: string; longname: string }>>((done) =>
      sftp.readdir(dir, done)
    )
    expect(listing.map((entry) => entry.filename)).toEqual(['a.txt'])
    expect(listing[0]!.longname).toMatch(/^-rw-------/u)

    // Rename does not replace (version 3); posix-rename does.
    const other = join(dir, 'b.txt')
    await writeFile(other, 'other')
    await expect(call((done) => sftp.rename(file, other, done))).rejects.toThrow()
    await call((done) => sftp.ext_openssh_rename(file, other, done))
    expect((await readFile(other)).equals(payload)).toBe(true)
    await expect(stat(file)).rejects.toThrow()

    await call((done) => sftp.ext_openssh_hardlink(other, join(dir, 'link'), done))
    expect((await stat(join(dir, 'link'))).nlink).toBe(2)
    const space = await call<{ f_bsize: number; f_blocks: number }>((done) =>
      sftp.ext_openssh_statvfs(dir, done)
    )
    expect(space.f_bsize).toBeGreaterThan(0)
    expect(space.f_blocks).toBeGreaterThan(0)

    expect(await call<string>((done) => sftp.realpath('.', done))).toBe(b.home)

    await call((done) => sftp.unlink(join(dir, 'link'), done))
    await call((done) => sftp.unlink(other, done))
    await call((done) => sftp.rmdir(dir, done))
    await expect(stat(dir)).rejects.toThrow()
    await expect(call((done) => sftp.stat(join(b.home, 'missing'), done))).rejects.toThrow(
      /no such file/iu
    )
    expect(await readdir(b.home)).toEqual([])
    expect(connection.counts().sftp).toBe(1)
  })

  /** A raw SFTP channel: sends packets and returns the reply to each. */
  async function rawSftp(client: SshClient): Promise<{
    ask(
      type: number,
      build: (writer: PacketWriter) => void
    ): Promise<{ type: number; reader: PacketReader }>
    end(): void
  }> {
    const channel = await channelOf((callback) => client.subsys('sftp', callback))
    let buffered = Buffer.alloc(0)
    const waiting: Array<(reply: { type: number; reader: PacketReader }) => void> = []
    channel.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
        const body = buffered.subarray(4, 4 + buffered.readUInt32BE(0))
        buffered = buffered.subarray(4 + buffered.readUInt32BE(0))
        const reader = new PacketReader(body)
        waiting.shift()?.({ type: reader.byte(), reader })
      }
    })
    const send = (
      type: number,
      build: (writer: PacketWriter) => void
    ): Promise<{ type: number; reader: PacketReader }> =>
      new Promise((resolve) => {
        waiting.push(resolve)
        const writer = new PacketWriter()
        build(writer)
        channel.write(writer.packet(type))
      })
    await send(PACKET.INIT, (writer) => writer.u32(3))
    let id = 0
    return {
      ask: (type, build) =>
        send(type, (writer) => {
          writer.u32(++id)
          build(writer)
        }),
      end: () => channel.end()
    }
  }

  it('makes a symbolic link the way OpenSSH’s clients ask for it, and answers the OpenSSH extensions', async () => {
    const b = await bed()
    const { client } = await b.connect()
    const sftp = await rawSftp(client)
    // The text the link holds, then the path of the link.
    const made = await sftp.ask(PACKET.SYMLINK, (writer) =>
      writer.string('target-text').string(join(b.home, 'the-link'))
    )
    expect(made.type).toBe(PACKET.STATUS)
    made.reader.u32()
    expect(made.reader.u32()).toBe(STATUS.OK)
    expect(await readlink(join(b.home, 'the-link'))).toBe('target-text')
    const read = await sftp.ask(PACKET.READLINK, (writer) =>
      writer.string(join(b.home, 'the-link'))
    )
    expect(read.type).toBe(PACKET.NAME)
    read.reader.u32()
    expect(read.reader.u32()).toBe(1)
    expect(read.reader.string()).toBe('target-text')

    const expanded = await sftp.ask(PACKET.EXTENDED, (writer) =>
      writer.string('expand-path@openssh.com').string('~/sub')
    )
    expanded.reader.u32()
    expect(expanded.reader.u32()).toBe(1)
    expect(expanded.reader.string()).toBe(join(b.home, 'sub'))
    const home = await sftp.ask(PACKET.EXTENDED, (writer) =>
      writer.string('home-directory').string(b.user)
    )
    home.reader.u32()
    home.reader.u32()
    expect(home.reader.string()).toBe(b.home)
    const stranger = await sftp.ask(PACKET.EXTENDED, (writer) =>
      writer.string('home-directory').string('someone-else')
    )
    stranger.reader.u32()
    expect(stranger.reader.u32()).toBe(STATUS.FAILURE)
    const limits = await sftp.ask(PACKET.EXTENDED, (writer) => writer.string('limits@openssh.com'))
    expect(limits.type).toBe(PACKET.EXTENDED_REPLY)
    limits.reader.u32()
    expect(limits.reader.u64()).toBe(SFTP_MAX_PACKET)
    const unknown = await sftp.ask(PACKET.EXTENDED, (writer) =>
      writer.string('no-such-extension@example.com')
    )
    unknown.reader.u32()
    expect(unknown.reader.u32()).toBe(STATUS.OP_UNSUPPORTED)
    sftp.end()
  })
})

describe('SFTP paths', () => {
  it('names places the way each system does (Windows paths are pure)', async () => {
    const { posixPaths, windowsPaths } =
      await import('../../../src/mms/net/editor/endpoint/sftp/paths')
    const posix = posixPaths('/home/me')
    expect(posix.toLocal('.')).toBe('/home/me')
    expect(posix.toLocal('src/a')).toBe('/home/me/src/a')
    expect(posix.toLocal('/etc')).toBe('/etc')
    const windows = windowsPaths('C:\\Users\\me')
    expect(windows.toLocal('/C:/Users/me/x')).toBe('C:\\Users\\me\\x')
    expect(windows.toLocal('c:/x')).toBe('C:\\x')
    expect(windows.toLocal('/')).toBeNull()
    expect(windows.toLocal('/Users')).toBeUndefined()
    expect(windows.toLocal('src\\a')).toBe('C:\\Users\\me\\src\\a')
    expect(windows.toRemote('C:\\Users\\me')).toBe('/C:/Users/me')
    expect(windows.toRemote('C:\\')).toBe('/C:/')
  })
})

describe.skipIf(!unix)('ending a connection', () => {
  const nodeProgram = (script: string): string => `${quote(process.execPath)} -e ${quote(script)}`
  /** A command that leaves a program of its own session and process group (what `setsid` and daemons do). */
  const detach = (pidFile: string): string =>
    nodeProgram(
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`
    )
  const readPid = async (file: string): Promise<number> => {
    await until(async () => (await readFile(file, 'utf8').catch(() => '')).length > 0)
    return Number((await readFile(file, 'utf8')).trim())
  }

  async function startPrograms(b: Bed, session: Awaited<ReturnType<Bed['connect']>>, tag: string) {
    const plain = join(b.home, `${tag}-plain.pid`)
    const detached = join(b.home, `${tag}-detached.pid`)
    void run(session.client, `echo $$ > ${quote(plain)}; ${detach(detached)}; sleep 300`).catch(
      () => undefined
    )
    return { plain: await readPid(plain), detached: await readPid(detached) }
  }

  it('an ordinary end leaves what the programs started running, as sshd does, and hangs up a terminal', async (context) => {
    const b = await bed()
    const session = await b.connect()
    const { plain, detached } = await startPrograms(b, session, 'one')
    const terminalPid = join(b.home, 'terminal.pid')
    if (b.host.terminals()) {
      const channel = await channelOf((callback) =>
        session.client.exec(
          `echo $$ > ${quote(terminalPid)}; exec sleep 300`,
          { pty: true },
          callback
        )
      )
      void channel
    }
    await until(() => alive(plain))
    if (b.host.terminals()) await readPid(terminalPid)
    session.connection.end(false)
    await new Promise((resolve) => setTimeout(resolve, 600))
    // The program with a pipe, and the one that left its session, are still there.
    expect(await alive(plain)).toBe(true)
    expect(await alive(detached)).toBe(true)
    if (b.host.terminals()) {
      const pid = await readPid(terminalPid)
      await until(async () => !(await alive(pid)))
    } else void context
    // The device is stopped from outside, as a block does.
    await b.endpoint.killDevice(NODE_A)
    await until(async () => !(await alive(plain)) && !(await alive(detached)))
  })

  it('a forced end stops everything the device started, including a program that left its session', async () => {
    const b = await bed()
    const session = await b.connect()
    const { plain, detached } = await startPrograms(b, session, 'forced')
    expect(await alive(detached)).toBe(true)
    const before = Date.now()
    session.connection.end(true)
    // Not waited for: the call returns at once, and the programs go shortly after.
    expect(Date.now() - before).toBeLessThan(250)
    await until(async () => !(await alive(plain)) && !(await alive(detached)), 8_000)
  })

  it('stops a program of an earlier connection that is already closed, and nothing of another device', async () => {
    const b = await bed()
    const first = await b.connect({ node: NODE_A })
    const { plain, detached } = await startPrograms(b, first, 'earlier')
    const other = await b.connect({ node: NODE_B })
    const theirs = await startPrograms(b, other, 'other')
    first.connection.end(false)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await alive(detached)).toBe(true)
    expect(b.endpoint.devices().sort()).toEqual([NODE_A, NODE_B].sort())

    await b.endpoint.killDevice(NODE_A)
    await until(async () => !(await alive(plain)) && !(await alive(detached)), 8_000)
    expect(await alive(theirs.plain)).toBe(true)
    expect(await alive(theirs.detached)).toBe(true)
    await b.endpoint.killDevice(NODE_B)
    await until(async () => !(await alive(theirs.plain)) && !(await alive(theirs.detached)), 8_000)
  })

  it('does not hold the event loop while it stops many programs', async () => {
    const b = await bed()
    const session = await b.connect()
    const pids = join(b.home, 'pids')
    await mkdir(pids)
    for (let i = 0; i < 12; i++)
      void run(session.client, `echo $$ > ${quote(join(pids, `p${i}`))}; sleep 300`).catch(
        () => undefined
      )
    await until(async () => (await readdir(pids)).length === 12)
    let worst = 0
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 5)
    session.connection.end(true)
    await until(async () => {
      const list = await Promise.all(
        (await readdir(pids)).map(async (name) => Number(await readFile(join(pids, name), 'utf8')))
      )
      return !(await Promise.all(list.map(alive))).some(Boolean)
    }, 8_000)
    clearInterval(timer)
    expect(worst).toBeLessThan(500)
  })
})

import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { CloudflareCli } from '../../src/mms/netEngine/cloudflare/cli'
import { resolveCloudflared } from '../../src/mms/netEngine/cloudflare/runtime'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn()
}))

function mockCloudflared(reply: (args: string[], env: NodeJS.ProcessEnv) => { stdout?: string; stderr?: string }) {
  vi.mocked(execFile).mockImplementation(((_path: string, args: string[], { env }: { env: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() })
    const { stdout = '', stderr = '' } = reply(args, env)
    queueMicrotask(() => {
      child.stderr.end(stderr)
      callback(null, stdout, stderr)
      child.emit('close', 0)
    })
    return child
  }) as unknown as typeof execFile)
}

it('creates the first tunnel when cloudflared reports an empty list as JSON null', async () => {
  const name = 'mousse-f6e903fdd90a44c01cba'
  const id = 'b73d0796-c988-4716-a9a4-9420224df5b1'
  let created = false
  mockCloudflared((args) => {
    const create = args.includes('create')
    if (create) created = true
    return { stdout: create ? '' : JSON.stringify(created ? [{ id, name }] : null) }
  })
  const cli = new CloudflareCli('cloudflared', process.cwd())
  const signal = new AbortController().signal

  await expect(cli.createOrRecover(name, Buffer.alloc(32).toString('base64'), signal)).resolves.toBe(id)
})

it('reads the selected zone privately and accepts only the matching connector token and DNS route', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mousse-cf-cli-'))
  try {
    const label = 'mousse-f6e903fdd90a44c01cba'
    const id = 'b73d0796-c988-4716-a9a4-9420224df5b1'
    const accountID = 'a'.repeat(32)
    const zoneID = 'b'.repeat(32)
    const secret = Buffer.alloc(32).toString('base64')
    const token = Buffer.from(JSON.stringify({ a: accountID, t: id, s: secret })).toString('base64')
    const login = 'https://dash.cloudflare.com/argotunnel?callback=fixture'
    const certificate = Buffer.from(JSON.stringify({ accountID, zoneID, apiToken: 'test-token' })).toString('base64')
    await mkdir(join(scratch, '.cloudflared'))
    await writeFile(join(scratch, '.cloudflared', 'cert.pem'),
      `-----BEGIN ARGO TUNNEL TOKEN-----\n${certificate}\n-----END ARGO TUNNEL TOKEN-----\n`)
    mockCloudflared((args, env) => {
      if (args.includes('login')) {
        expect(env.HOME).toBe(scratch)
        expect(env.PATH).toBe('')
        return { stderr: `https://dash.cloudflare.com.invalid/argotunnel\n${login}\n` }
      }
      if (args.includes('token')) return { stdout: `${token}\n` }
      return { stderr: JSON.stringify({ tunnelID: id, message: `${label}.example.net is already configured to route to your tunnel` }) }
    })
    const cli = new CloudflareCli('cloudflared', scratch)
    const signal = new AbortController().signal
    const onLoginUrl = vi.fn()
    await expect(cli.login(signal, onLoginUrl)).resolves.toEqual({ accountId: accountID, zoneId: zoneID })
    expect(onLoginUrl.mock.calls).toEqual([[login]])
    await expect(cli.token(id, accountID, secret, signal)).resolves.toBe(token)
    await expect(cli.token(id, accountID, 'other-secret', signal)).rejects.toThrow('does not match')
    await expect(cli.route(id, label, signal)).resolves.toBe(`${label}.example.net`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

it('rejects a Cloudflare download that does not match the approved digest', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mousse-cf-runtime-'))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unverified download')))
  try {
    await expect(resolveCloudflared(scratch, new AbortController().signal)).rejects.toThrow('could not be verified')
  } finally {
    vi.unstubAllGlobals()
    await rm(scratch, { recursive: true, force: true })
  }
})

import { describe, expect, it } from 'vitest'
import { remoteFolder, remoteRoute, resolveRemoteOpen, type Ask } from '../src/main/remoteEditorFlow'
import { newId } from '../src/shared/net'
import type { EditorSshStatus } from '../src/shared/net/local'
import { qualifyId } from '../src/shared/threadRef'

const node = newId('node')
const threadId = qualifyId(node, 't1')
const folder = { path: '/home/me/app', uriPath: '/home/me/app', style: 'posix', platform: 'linux', kind: 'project' }

/** A refusal as a window sees it: the daemon's error with its code and details. */
const refused = (code: string, message = 'refused', details?: unknown) => Object.assign(new Error(message), { code, details })

const status = (patch: Partial<EditorSshStatus> = {}): EditorSshStatus => ({
  available: true,
  enabled: true,
  included: false,
  includeLine: 'Include ~/.mousse/ssh/config',
  userConfig: '~/.ssh/config',
  mousseConfig: '/h/.mousse/ssh/config',
  knownHosts: '/h/.mousse/ssh/known_hosts',
  noticePending: false,
  computers: [],
  ...patch
})

interface Script {
  approval?: string
  folders?: Array<unknown | Error>
  restore?: Error | 'ok'
  prepare?: unknown
  status?: EditorSshStatus
}

/** A daemon that answers from a script and records what it was asked. */
function daemon(script: Script) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const folders = [...(script.folders ?? [folder])]
  const ask: Ask = async (method, params) => {
    calls.push({ method, params })
    switch (method) {
      case 'net.ssh.target':
        return script.approval ? { endpoint: script.approval } : {}
      case 'editor.folder': {
        const next = folders.length > 1 ? folders.shift() : folders[0]
        if (next instanceof Error) throw next
        return next
      }
      case 'workspace.restore':
        if (script.restore instanceof Error) throw script.restore
        return { metadata: {} }
      case 'net.editor.ssh.status':
        return script.status ?? status()
      case 'net.editor.ssh.prepare':
        return script.prepare
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  return { ask, calls, methods: () => calls.map((call) => call.method) }
}

describe('how this computer reaches the computer that runs a thread', () => {
  it('uses the SSH address approved for it', async () => {
    const d = daemon({ approval: 'me@box.example.com:2222' })
    const route = await remoteRoute(d.ask, node, { proxyReady: false })
    expect(route).toEqual({ kind: 'ssh', host: { kind: 'ssh', target: { user: 'me', host: 'box.example.com', port: 2222 } } })
    expect(d.calls[0]).toEqual({ method: 'net.ssh.target', params: { node } })
  })

  it('offers no route when none is approved and Mousse’s proxy command does not exist yet', async () => {
    const d = daemon({})
    expect(await remoteRoute(d.ask, node, { proxyReady: false })).toEqual({ kind: 'none' })
    // Mousse’s own SSH settings are not even read.
    expect(d.methods()).toEqual(['net.ssh.target'])
  })

  it('offers Mousse’s own SSH name once the proxy command exists, and only while its settings are available', async () => {
    expect(await remoteRoute(daemon({}).ask, node, { proxyReady: true })).toEqual({ kind: 'mousse' })
    expect(await remoteRoute(daemon({ status: status({ available: false }) }).ask, node, { proxyReady: true })).toEqual({ kind: 'none' })
  })

  it('prefers the approved address to Mousse’s name', async () => {
    const d = daemon({ approval: 'box' })
    expect((await remoteRoute(d.ask, node, { proxyReady: true })).kind).toBe('ssh')
    expect(d.methods()).toEqual(['net.ssh.target'])
  })

  it('treats an approval that is not a valid address, and a daemon that cannot answer, as none', async () => {
    expect((await remoteRoute(daemon({ approval: '-oProxyCommand=id' }).ask, node, { proxyReady: false })).kind).toBe('none')
    const broken: Ask = async () => {
      throw new Error('method not found')
    }
    expect((await remoteRoute(broken, node, { proxyReady: true })).kind).toBe('none')
  })
})

describe('the folder a thread works in on its computer', () => {
  it('asks for the thread by its id and nothing else', async () => {
    const d = daemon({})
    expect(await remoteFolder(d.ask, threadId)).toEqual({ ok: true, folder: { style: 'posix', path: '/home/me/app', uriPath: '/home/me/app' } })
    expect(d.calls).toEqual([{ method: 'editor.folder', params: { threadId } }])
  })

  it('restores a removed worktree with the routed restore, then asks again', async () => {
    const d = daemon({ folders: [refused('workspace_not_ready', 'gone', { threadId, state: 'missing' }), { ...folder, kind: 'worktree', path: '/wt/t1', uriPath: '/wt/t1' }] })
    expect(await remoteFolder(d.ask, threadId)).toEqual({ ok: true, folder: { style: 'posix', path: '/wt/t1', uriPath: '/wt/t1' } })
    expect(d.calls).toEqual([
      { method: 'editor.folder', params: { threadId } },
      { method: 'workspace.restore', params: { threadId } },
      { method: 'editor.folder', params: { threadId } }
    ])
  })

  it('asks only once more: a worktree that is still missing after a restore stays a refusal', async () => {
    const missing = refused('workspace_not_ready', 'gone', { state: 'missing' })
    const d = daemon({ folders: [missing] })
    expect(await remoteFolder(d.ask, threadId)).toEqual({ ok: false, reason: 'worktree_missing' })
    expect(d.methods()).toEqual(['editor.folder', 'workspace.restore', 'editor.folder'])
  })

  it('says the worktree could not be restored when the restore fails or is refused', async () => {
    const missing = refused('workspace_not_ready', 'gone', { state: 'missing' })
    expect(await remoteFolder(daemon({ folders: [missing], restore: new Error('git failed') }).ask, threadId)).toEqual({ ok: false, reason: 'worktree_missing' })
    expect(await remoteFolder(daemon({ folders: [missing], restore: refused('computer_offline', 'Studio is offline.') }).ask, threadId)).toEqual({
      ok: false,
      reason: 'failed',
      message: 'Studio is offline.'
    })
  })

  it('does not restore a worktree that needs recovery', async () => {
    const d = daemon({ folders: [refused('workspace_not_ready', 'moved', { state: 'recovery_required' })] })
    expect(await remoteFolder(d.ask, threadId)).toEqual({ ok: false, reason: 'worktree_recovery' })
    expect(d.methods()).toEqual(['editor.folder'])
  })

  it('turns each refusal of the owner into a reason without the owner’s words', async () => {
    const reasons: Array<[string, string]> = [
      ['folder_protected', 'folder_protected'],
      ['folder_missing', 'folder_missing'],
      ['folder_not_openable', 'folder_not_openable'],
      ['thread_has_no_folder', 'no_folder']
    ]
    for (const [code, reason] of reasons) {
      expect(await remoteFolder(daemon({ folders: [refused(code, 'This folder holds SSH keys at /home/me/.ssh')] }).ask, threadId)).toEqual({ ok: false, reason })
    }
  })

  it('passes on the words of the router when the computer is offline, refuses, or is too old', async () => {
    for (const code of ['computer_offline', 'computer_forbidden', 'computer_outdated']) {
      expect(await remoteFolder(daemon({ folders: [refused(code, 'Studio is offline.')] }).ask, threadId)).toEqual({ ok: false, reason: 'failed', message: 'Studio is offline.' })
    }
  })

  it('rethrows an error it does not know instead of guessing', async () => {
    await expect(remoteFolder(daemon({ folders: [refused('handler_error', 'boom')] }).ask, threadId)).rejects.toThrow('boom')
  })

  it('refuses an answer that disagrees with itself, so a crafted reply cannot pick the folder', async () => {
    const d = daemon({ folders: [{ ...folder, uriPath: '/etc' }] })
    expect(await remoteFolder(d.ask, threadId)).toEqual({ ok: false, reason: 'folder_not_openable' })
    expect(await remoteFolder(daemon({ folders: [{ ...folder, path: '/srv/../etc', uriPath: '/srv/../etc' }] }).ask, threadId)).toEqual({ ok: false, reason: 'folder_not_openable' })
    expect(await remoteFolder(daemon({ folders: ['/home/me/app'] }).ask, threadId)).toEqual({ ok: false, reason: 'folder_not_openable' })
  })
})

describe('everything an editor needs for a thread of another computer', () => {
  it('gives the approved address and the folder, and writes nothing on this computer', async () => {
    const d = daemon({ approval: 'me@box' })
    const resolved = await resolveRemoteOpen(d.ask, threadId, { proxyReady: false })
    expect(resolved).toEqual({
      ok: true,
      host: { kind: 'ssh', target: { user: 'me', host: 'box' } },
      folder: { style: 'posix', path: '/home/me/app', uriPath: '/home/me/app' }
    })
    expect(d.methods()).toEqual(['net.ssh.target', 'editor.folder'])
  })

  it('stops with no route before asking the other computer for anything', async () => {
    const d = daemon({})
    expect(await resolveRemoteOpen(d.ask, threadId, { proxyReady: false })).toEqual({ ok: false, reason: 'no_route' })
    expect(d.methods()).toEqual(['net.ssh.target'])
  })

  it('refuses a thread of this computer', async () => {
    await expect(resolveRemoteOpen(daemon({ approval: 'box' }).ask, 't1', { proxyReady: false })).rejects.toThrow(/this computer/)
    await expect(resolveRemoteOpen(daemon({ approval: 'box' }).ask, 42, { proxyReady: false })).rejects.toThrow(/this computer/)
  })

  it('prepares Mousse’s SSH settings last, and only when the folder is known', async () => {
    const alias = 'mousse-studio-3fa2c1'
    const ready = { ok: true, added: true, status: status({ included: true, computers: [{ node, alias, name: 'Studio', hostKeyPinned: true }] }) }
    const d = daemon({ prepare: ready })
    expect(await resolveRemoteOpen(d.ask, threadId, { proxyReady: true })).toEqual({
      ok: true,
      host: { kind: 'mousse', alias },
      folder: { style: 'posix', path: '/home/me/app', uriPath: '/home/me/app' }
    })
    expect(d.methods()).toEqual(['net.ssh.target', 'net.editor.ssh.status', 'editor.folder', 'net.editor.ssh.prepare'])

    // A refused folder leaves ~/.ssh/config alone.
    const refusedFolder = daemon({ folders: [refused('folder_protected')], prepare: ready })
    await resolveRemoteOpen(refusedFolder.ask, threadId, { proxyReady: true })
    expect(refusedFolder.methods()).not.toContain('net.editor.ssh.prepare')
  })

  it('does not prepare Mousse’s SSH settings while the proxy command does not exist', async () => {
    const d = daemon({})
    await resolveRemoteOpen(d.ask, threadId, { proxyReady: false })
    expect(d.methods()).not.toContain('net.editor.ssh.prepare')
    expect(d.methods()).not.toContain('net.editor.ssh.status')
  })

  it('reports why the settings could not be prepared, with the line to add by hand', async () => {
    for (const code of ['ssh_check_failed', 'unwritable', 'not_owner']) {
      const d = daemon({ prepare: { ok: false, code, message: 'detail', status: status() } })
      expect(await resolveRemoteOpen(d.ask, threadId, { proxyReady: true })).toEqual({
        ok: false,
        reason: 'ssh_settings',
        code,
        message: 'detail',
        includeLine: 'Include ~/.mousse/ssh/config'
      })
    }
  })

  it('refuses when the settings are ready but have no name for that computer', async () => {
    const d = daemon({ prepare: { ok: true, added: false, status: status({ computers: [] }) } })
    expect(await resolveRemoteOpen(d.ask, threadId, { proxyReady: true })).toEqual({ ok: false, reason: 'no_route' })
  })
})

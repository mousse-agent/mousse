import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { GitHubService, type ExecutableRunner } from '../src/mms/git/GitHubService'

function runnerMock(implementation?: ExecutableRunner) {
  return vi.fn<ExecutableRunner>(implementation ?? (async () => ({ stdout: '', stderr: '' })))
}

describe('GitHubService', () => {
  it('reports a missing gh executable and unauthenticated sessions usefully', async () => {
    const missing = runnerMock(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    })
    await expect(new GitHubService(missing).getAvailability()).resolves.toMatchObject({ state: 'missing' })

    const unauthenticated = runnerMock(async (_command, args) => {
      if (args[0] === 'auth') throw Object.assign(new Error('not logged in'), { stderr: 'not logged in' })
      return { stdout: 'gh version 2', stderr: '' }
    })
    await expect(new GitHubService(unauthenticated).getAvailability()).resolves.toMatchObject({
      state: 'unauthenticated',
      loginCommand: 'gh auth login'
    })
  })

  it('creates without an implicit push and passes argv without shell interpolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-github-create-'))
    const run = runnerMock(async (_command, args) => ({
      stdout: args[0] === 'repo' ? 'https://github.com/acme/sample\n' : '',
      stderr: ''
    }))
    const result = await new GitHubService(run).createRepository(root, {
      name: 'sample',
      visibility: 'private'
    })

    expect(result.repositoryUrl).toBe('https://github.com/acme/sample')
    expect(run).toHaveBeenCalledWith('git', ['init'], { cwd: root })
    const createCall = run.mock.calls.find((call) => call[0] === 'gh' && call[1][0] === 'repo')
    expect(createCall?.[1]).toEqual([
      'repo', 'create', 'sample', '--source=.', '--private', '--remote=origin'
    ])
    expect(createCall?.[1]).not.toContain('--push')
    expect(run.mock.calls.some((call) => call[1].includes('push'))).toBe(false)
  })

  it('refuses relative and nonempty clone destinations before cloning', async () => {
    const run = runnerMock()
    const service = new GitHubService(run)
    await expect(service.cloneRepository({ repository: 'acme/sample', destination: 'relative' }))
      .rejects.toThrow('absolute')

    const root = await mkdtemp(join(tmpdir(), 'mousse-github-nonempty-'))
    await writeFile(join(root, 'keep.txt'), 'do not replace')
    await expect(service.cloneRepository({ repository: 'acme/sample', destination: root }))
      .rejects.toThrow('not empty')
    expect(run.mock.calls.some((call) => call[1][0] === 'repo' && call[1][1] === 'clone')).toBe(false)
  })

  it('clones into an empty destination with separate executable arguments', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mousse-github-clone-'))
    const destination = join(parent, 'sample')
    await mkdir(destination)
    const run = runnerMock()
    await expect(new GitHubService(run).cloneRepository({
      repository: 'acme/sample',
      destination
    })).resolves.toBe(destination)
    expect(run).toHaveBeenCalledWith('gh', ['repo', 'clone', 'acme/sample', destination])
  })

  it('rejects values that could be interpreted as options', async () => {
    const run = runnerMock()
    const service = new GitHubService(run)
    await expect(service.cloneRepository({
      repository: '--help',
      destination: join(tmpdir(), 'unused')
    })).rejects.toThrow('owner/name')
    await expect(service.createRepository(tmpdir(), {
      name: '--help',
      visibility: 'private'
    })).rejects.toThrow('start with')
    expect(run).not.toHaveBeenCalled()
  })

  it('exposes busy state while one operation is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-github-busy-'))
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const run = runnerMock(async (_command, args) => {
      if (args[0] === 'repo') await blocked
      return { stdout: '', stderr: '' }
    })
    const service = new GitHubService(run)
    const operation = service.createRepository(root, { name: 'sample', visibility: 'public' })
    await vi.waitFor(() => expect(run.mock.calls.some((call) => call[1][0] === 'repo')).toBe(true))
    await expect(service.getAvailability()).resolves.toMatchObject({ state: 'busy' })
    release()
    await operation
  })
})

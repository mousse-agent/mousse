import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorktreeManager } from '../../../../src/mms/worktree/WorktreeManager'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
}

function fixture(processFilter: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'safe-checkout-')))
  roots.push(root)
  const repo = join(root, 'repo'),
    home = join(root, 'home'),
    marker = join(root, 'filter-executed'),
    globalConfig = join(root, 'gitconfig'),
    program = join(root, 'filter.cjs')
  mkdirSync(repo)
  mkdirSync(home)
  const plain = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'empty'),
    GIT_CONFIG_NOSYSTEM: '1'
  }
  writeFileSync(plain.GIT_CONFIG_GLOBAL, '')
  run(repo, ['init', '-q', '-b', 'main'], plain)
  run(repo, ['config', 'user.name', 'Test'], plain)
  run(repo, ['config', 'user.email', 'test@example.invalid'], plain)
  writeFileSync(join(repo, '.gitattributes'), '*.bin filter=probe.name\n')
  writeFileSync(join(repo, 'asset.bin'), 'stored bytes\n')
  run(repo, ['add', '.'], plain)
  run(repo, ['commit', '-q', '-m', 'initial'], plain)
  writeFileSync(
    program,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout)`
  )
  const command = `"${process.execPath.replaceAll('\\', '/')}" "${program.replaceAll('\\', '/')}"`
  writeFileSync(globalConfig, '')
  for (const driver of processFilter ? ['clean', 'smudge', 'process'] : ['clean', 'smudge'])
    run(repo, ['config', '--file', globalConfig, `filter.probe.name.${driver}`, command], plain)
  run(repo, ['config', '--file', globalConfig, 'filter.probe.name.required', 'true'], plain)
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  return { repo, home, marker }
}

it('checks out with globally configured required filters disabled instead of refusing', async () => {
  const f = fixture(true),
    manager = new WorktreeManager(f.repo, f.home),
    info = await manager.createWorktree('agent-safe-checkout', f.repo, undefined, undefined, {
      safeCheckout: true
    })
  expect(existsSync(f.marker)).toBe(false)
  expect(readFileSync(join(info.path, 'asset.bin'), 'utf8')).toBe('stored bytes\n')
})

it('preserves configured filters for ordinary local agent worktrees', async () => {
  const f = fixture(false),
    manager = new WorktreeManager(f.repo, f.home),
    info = await manager.createWorktree('agent-ordinary-checkout')
  expect(readFileSync(f.marker, 'utf8')).toBe('executed')
  expect(readFileSync(join(info.path, 'asset.bin'), 'utf8')).toBe('stored bytes\n')
})

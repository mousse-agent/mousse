import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clampBashTimeoutSeconds,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  isFilesystemWideBashCommand,
  isPathInsideCwd,
  MAX_BASH_TIMEOUT_SECONDS,
  normalizeOsPath,
  resolveToolPath,
  sanitizeToolArgs
} from '../src/mms/orchestrator/toolPathSafety'
import { PiCodingTools } from '../src/mms/orchestrator/PiCodingTools'

describe('toolPathSafety', () => {
  it('normalizes Git Bash and WSL drive paths on Windows', () => {
    if (process.platform !== 'win32') return

    expect(normalizeOsPath('/c/Users/bubbl/project/file.ts')).toBe(
      'C:\\Users\\bubbl\\project\\file.ts'
    )
    expect(normalizeOsPath('/mnt/d/work/a.txt')).toBe('D:\\work\\a.txt')
    expect(normalizeOsPath('subagent-lab/package.json')).toBe('subagent-lab/package.json')
  })

  it('resolves Git Bash absolute paths into the real worktree instead of C:\\c\\...', () => {
    if (process.platform !== 'win32') return

    const cwd = 'C:\\Users\\bubbl\\.mousse\\repositories\\demo\\worktrees\\agents\\abc'
    const gitBashPath =
      '/c/Users/bubbl/.mousse/repositories/demo/worktrees/agents/abc/subagent-lab/package.json'

    expect(resolveToolPath(gitBashPath, cwd)).toBe(
      'C:\\Users\\bubbl\\.mousse\\repositories\\demo\\worktrees\\agents\\abc\\subagent-lab\\package.json'
    )
    expect(isPathInsideCwd(gitBashPath, cwd)).toBe(true)
    // Un-normalized Node resolve would land under C:\c\...
    expect(resolveToolPath(gitBashPath, cwd).toLowerCase().startsWith('c:\\c\\')).toBe(false)
  })

  it('blocks filesystem-wide bash searches but allows project-local ones', () => {
    expect(isFilesystemWideBashCommand('grep -rl "Subagent Lab" /')).toBe(true)
    expect(
      isFilesystemWideBashCommand(
        'grep -rl "Subagent Lab issue-tracker CLI" / 2>/dev/null | head; find / -type d -name cli'
      )
    ).toBe(true)
    expect(isFilesystemWideBashCommand('find / -path /proc -prune -o -type d -name cli -print')).toBe(
      true
    )
    expect(isFilesystemWideBashCommand('find . -name package.json')).toBe(false)
    expect(isFilesystemWideBashCommand('grep -R pattern ./src')).toBe(false)
    expect(isFilesystemWideBashCommand('ls -la')).toBe(false)
  })

  it('clamps bash timeouts and defaults when missing', () => {
    expect(clampBashTimeoutSeconds(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
    expect(clampBashTimeoutSeconds(30)).toBe(30)
    expect(clampBashTimeoutSeconds(99999)).toBe(MAX_BASH_TIMEOUT_SECONDS)
  })

  it('sanitizes write args and refuses escapes outside cwd', () => {
    if (process.platform !== 'win32') return

    const cwd = 'C:\\Users\\bubbl\\project'
    const ok = sanitizeToolArgs(
      'write',
      {
        path: '/c/Users/bubbl/project/subagent-lab/package.json',
        content: '{}'
      },
      cwd
    )
    expect(ok.error).toBeUndefined()
    expect(ok.args.path).toBe(join('subagent-lab', 'package.json'))

    const blocked = sanitizeToolArgs(
      'write',
      { path: '/c/Windows/System32/drivers/etc/hosts', content: 'x' },
      cwd
    )
    expect(blocked.error).toMatch(/Refusing write outside/i)

    const bash = sanitizeToolArgs('bash', { command: 'grep -rl foo /' }, cwd)
    expect(bash.error).toMatch(/filesystem-wide/i)

    const timed = sanitizeToolArgs('bash', { command: 'npm test' }, cwd)
    expect(timed.error).toBeUndefined()
    expect(timed.args.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
  })
})

describe('PiCodingTools path safety integration', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('writes Git Bash absolute paths into the worktree cwd, not C:\\c\\...', async () => {
    if (process.platform !== 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'mousse-path-safety-'))
    roots.push(root)
    const tools = new PiCodingTools()

    const gitBashPath = root
      .replace(/^([A-Za-z]):\\/, '/$1/')
      .replace(/\\/g, '/')
      .toLowerCase()
      // drive letter in git-bash paths is usually lowercase; normalizeOsPath uppercases
      .replace(/^\/([a-z])\//, (_, d: string) => `/${d}/`)
    // Rebuild with original drive casing from root
    const drive = root.match(/^([A-Za-z]):/)?.[1]?.toLowerCase() ?? 'c'
    const rest = root.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/')
    const absoluteGitBash = `/${drive}/${rest}/nested/out.txt`

    const result = await tools.execute(
      'write',
      { path: absoluteGitBash, content: 'from-git-bash-path\n' },
      root
    )

    expect(result.isError).toBe(false)
    const written = await readFile(join(root, 'nested', 'out.txt'), 'utf8')
    expect(written).toBe('from-git-bash-path\n')
  })

  it('rejects filesystem-wide bash before spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-bash-block-'))
    roots.push(root)
    const tools = new PiCodingTools()

    const result = await tools.execute(
      'bash',
      { command: 'grep -rl "Subagent Lab issue-tracker CLI" /' },
      root
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/filesystem-wide/i)
  })
})

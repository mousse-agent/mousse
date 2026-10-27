/**
 * #309: an agent's file tools never change Git metadata. A definition's (legacy loop and Mousse MCP
 * tools alike, through `prepareTrustedToolDispatch`) and a bot's (`createBotAuthority`) write or edit
 * of a path inside any `.git` folder, or of a `.git` file, is refused wherever it is, by its path as
 * written or its real path through links. Reads are unaffected.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { touchesGitMetadata } from '../../src/mms/agents/gitMetadata'
import { prepareTrustedToolDispatch } from '../../src/mms/agentDefinitions/runtimePolicy'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'

let root: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-git-guard-')))
  mkdirSync(join(root, '.git', 'objects', 'info'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  mkdirSync(join(root, 'src'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** The reviewers' repros, as file-tool writes: a config-defined hook, a late alternates file, the object store, a planted `.git`. */
const REPROS = [
  '.git/config',
  '.git/objects/info/alternates',
  '.git/objects/pack/pack-1.pack',
  '.git/hooks/post-index-change',
  '.git/commondir',
  'src/.git',
  'src/.git/HEAD',
  'nested/.GIT/config'
]

describe('touchesGitMetadata', () => {
  it('a path inside a .git folder or naming a .git file, any case, as written or through a link', () => {
    for (const path of REPROS) expect(touchesGitMetadata(path, root), path).toBe(true)
    if (process.platform === 'win32') for (const path of ['.git./config', '.git /config', '.git::$INDEX_ALLOCATION/config']) expect(touchesGitMetadata(path, root), path).toBe(true)
    // A junction (or symlink) to the git dir is the git dir.
    symlinkSync(join(root, '.git'), join(root, 'src', 'meta'), 'junction')
    expect(touchesGitMetadata('src/meta/config', root)).toBe(true)
    for (const path of ['src/app.ts', '.github/workflows/ci.yml', '.gitignore', '.gitattributes', 'src/git/notes.md']) expect(touchesGitMetadata(path, root), path).toBe(false)
  })
})

function policy(mode: AgentRuntimePolicy['workspace']['mode'] = 'thread_worktree'): AgentRuntimePolicy {
  return {
    profileId: 'p', threadId: 't', runId: 'r', definitionId: 'd', definitionRevision: 'v', source: 'editor',
    workspace: { mode, canonicalRoots: [root] },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: []
  }
}
const grants = { skills: [], mcpTools: [], builtinTools: ['read', 'write', 'edit'].map((id) => ({ id, source: 'definition' as never })), denied: [] }

describe("a definition's file tools", () => {
  it('refuse every write and edit of Git metadata, and still read it and write elsewhere', () => {
    const dispatch = (toolName: string, path: string) => prepareTrustedToolDispatch({ policy: policy(), grants, toolName, args: { path, content: 'x', oldText: 'a', newText: 'b' }, isMcp: false, projectPath: root })
    for (const path of REPROS) {
      for (const tool of ['write', 'edit']) {
        const prepared = dispatch(tool, path)
        expect(prepared.allowed, `${tool} ${path}`).toBe(false)
        expect(prepared.message, `${tool} ${path}`).toMatch(/cannot change Git metadata/)
      }
    }
    expect(dispatch('write', 'src/app.ts').allowed).toBe(true)
    expect(dispatch('read', '.git/config').allowed).toBe(true)
  })
})

describe("a bot's file tools", () => {
  it('meet a wall for every write of Git metadata, in a root or its scratch folder, and still read it', () => {
    const scratch = join(root, 'scratch')
    mkdirSync(scratch)
    const bot = createBotAuthority({
      activationId: 'a', role: 'activation',
      permissions: { tools: ['read', 'write', 'edit'], appTools: [], skills: [], mcp: [], workspace: { roots: [root], access: 'write', writeRoots: [root], scratch } } as never,
      waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => 0, signal: new AbortController().signal },
      spend: null
    })
    const call = (tool: 'write' | 'edit' | 'read', path: string) => bot.check({ kind: 'builtin', tool, nativeName: tool, args: { path: join(root, path) } })
    for (const path of REPROS) expect(call('write', path), path).toMatchObject({ ok: false, wall: { kind: 'path', access: 'write' } })
    expect(bot.check({ kind: 'builtin', tool: 'write', nativeName: 'write', args: { path: '.git/config' } })).toMatchObject({ ok: false })
    expect(call('write', 'src/app.ts')).toEqual({ ok: true })
    expect(call('read', '.git/config')).toEqual({ ok: true })
  })
})

describe("the legacy loop's route: the gate checks the path Pi opens (ProjectFileTools.piArgs, then execute)", () => {
  it('`@` and `~` forms are refused into .git and out of the roots, and the tool gets exactly the checked path', async () => {
    const { ProjectFileTools } = await import('../../src/mms/workflows/tools/ProjectFileTools')
    const tools = new ProjectFileTools()
    // A test home folder outside the roots: nothing could reach the real one.
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-git-guard-home-')))
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      // As LlmClient runs a definition's Pi file tool: resolve as Pi does, check, then execute those arguments.
      const run = async (toolName: string, args: Record<string, unknown>) => {
        const resolved = tools.piArgs(toolName, args, root)
        const prepared = prepareTrustedToolDispatch({ policy: policy(), grants, toolName, args: resolved, isMcp: false, projectPath: root })
        return prepared.allowed ? { allowed: true, result: await tools.execute(toolName, resolved, root) } : { allowed: false, message: prepared.message }
      }
      for (const path of ['@.git/config', '@.git/objects/info/alternates', '@.git/hooks/post-index-change']) {
        expect(await run('write', { path, content: 'planted\n' }), path).toMatchObject({ allowed: false, message: expect.stringMatching(/cannot change Git metadata/) })
      }
      expect(await run('edit', { path: '@.git/config', edits: [{ oldText: '[core]', newText: '[core]\n\tfsmonitor = x' }] })).toMatchObject({ allowed: false })
      for (const path of ['~/escaped.txt', '@~/escaped.txt', '~/.gitconfig']) {
        expect(await run('write', { path, content: 'out\n' }), path).toMatchObject({ allowed: false, message: expect.stringMatching(/escaped allowed workspace roots/) })
      }
      expect(await run('read', { path: '~/.gitconfig' })).toMatchObject({ allowed: false })
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
      expect(existsSync(join(root, '.git', 'objects', 'info', 'alternates'))).toBe(false)
      expect(existsSync(join(home, 'escaped.txt'))).toBe(false)
      // `@@name` is the literal file `@name`, written there and nowhere else.
      expect(await run('write', { path: '@@.git/config', content: 'literal\n' })).toMatchObject({ allowed: true, result: { isError: false } })
      expect(readFileSync(join(root, '@.git', 'config'), 'utf8')).toBe('literal\n')
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
      // An ordinary `@`-prefixed path still lands where Pi puts it.
      expect(await run('write', { path: '@src/app.ts', content: 'ok\n' })).toMatchObject({ allowed: true, result: { isError: false } })
      expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe('ok\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

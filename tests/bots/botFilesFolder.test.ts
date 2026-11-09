/**
 * Bot Phase 1 §5.10: a bot's files folder `<profileHome>/bots/files/<botId>/` is writable by the
 * bot like its scratch folder, although it sits inside Mousse's data, and is never a permission:
 * it is not one of the grant's roots, so About never lists it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { botFilesFolder, botManifestDigest, compileBotThread, type CompileInput } from '../../src/mms/bots/grants/compile'
import { PI_NATIVE_TOOLS } from '../../src/mms/harness/pi/nativeTools'
import type { BotManifest } from '../../src/shared/bots/personal/definition'
import { botStarterManifest, describeManifest } from '../../src/shared/bots/personal/manifest'
import { BOT_MEMORY_TOOLS } from '../../src/shared/bots/personal/memory'
import type { NeutralTool } from '../../src/shared/harness/tools'

let base: string
let profile: string
let files: string
let scratch: string
let notes: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-bot-files-')))
  profile = join(base, 'profile')
  files = botFilesFolder(profile, 'bot-1')
  scratch = join(profile, 'bots', 'scratch', 'act-1')
  notes = join(base, 'Notes')
  for (const dir of [files, scratch, notes]) mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const piNames = (tools: readonly NeutralTool[]) => ({ ok: true as const, names: tools.flatMap((tool) => [...(PI_NATIVE_TOOLS[tool] ?? [])]) })

const compile = (patch: Partial<CompileInput> = {}) => {
  const grant = patch.grant ?? botStarterManifest()
  return compileBotThread({
    grant,
    digest: botManifestDigest(grant),
    thread: {},
    scratch,
    profileHome: profile,
    filesFolder: files,
    nativeNames: piNames,
    remaining: { deadlineMs: 600_000 },
    ...patch
  })
}

const authorityOf = (patch: Partial<CompileInput> = {}) => {
  const compiled = compile(patch)
  if (!compiled.ok) throw new Error(compiled.error.message)
  return createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: compiled.permissions,
    waiting: () => false,
    counters: { charge: () => ({ ok: true, count: 1 }) },
    time: { deadline: () => 0, signal: new AbortController().signal },
    spend: null
  })
}

const builtin = (tool: NeutralTool, path: string) => ({ kind: 'builtin' as const, tool, nativeName: tool, args: { path } })

describe('the files folder', () => {
  it('is at <profileHome>/bots/files/<botId>', () => {
    expect(botFilesFolder('/home/me/.mousse/profiles/p1', 'b1')).toBe(join('/home/me/.mousse/profiles/p1', 'bots', 'files', 'b1'))
  })

  it('compiles as a writable folder beside the grant, never as one of its roots', () => {
    const compiled = compile()
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.permissions.workspace).toEqual({ roots: [], access: 'read', writeRoots: [], scratch: realpathSync(scratch), files: realpathSync(files) })
    // The starter grant names no folder at all: About lists nothing for it.
    expect(describeManifest(botStarterManifest()).filter((line) => line.kind === 'workspace')).toEqual([])
  })

  it('lets the bot read and write in it, and nowhere else it was not given', () => {
    const authority = authorityOf()
    expect(authority.check(builtin('write', join(files, 'report.md')))).toEqual({ ok: true })
    expect(authority.check(builtin('edit', join(files, 'drafts', 'a.md')))).toEqual({ ok: true })
    expect(authority.check(builtin('read', join(files, 'report.md')))).toEqual({ ok: true })
    expect(authority.check(builtin('list', files))).toEqual({ ok: true })
    expect(authority.check(builtin('write', join(scratch, 'tmp.txt')))).toEqual({ ok: true })
    expect(authority.check(builtin('write', join(notes, 'a.md')))).toMatchObject({ ok: false, wall: { kind: 'path', access: 'write' } })
    expect(authority.check(builtin('read', join(profile, 'bots.db')))).toMatchObject({ ok: false, wall: { kind: 'path', access: 'read' } })
    // Another bot's files folder is not this bot's.
    expect(authority.check(builtin('read', join(botFilesFolder(profile, 'bot-2'), 'x.md')))).toMatchObject({ ok: false, wall: { kind: 'path' } })
    expect(authority.workspace?.writeRoots).toContain(realpathSync(files))
  })

  it('stays the bot\'s with file access, while the rest of Mousse\'s data stays closed', () => {
    const grant: BotManifest = { ...botStarterManifest(), workspace: { roots: [notes], access: 'read' } }
    const authority = authorityOf({ grant })
    expect(authority.check(builtin('write', join(notes, 'a.md')))).toEqual({ ok: true })
    expect(authority.check(builtin('write', join(files, 'a.md')))).toEqual({ ok: true })
    expect(authority.check(builtin('write', join(scratch, 'a.md')))).toEqual({ ok: true })
    expect(authority.check(builtin('read', join(botFilesFolder(profile, 'bot-2'), 'x.md')))).toMatchObject({ ok: false, wall: { kind: 'closed' } })
    expect(authority.check(builtin('read', join(profile, 'bots', 'bots.db')))).toMatchObject({ ok: false, wall: { kind: 'closed' } })
    expect(authority.workspace).toMatchObject({ files: realpathSync(files), computer: { closed: profile } })
  })

  it('a grant an older build wrote naming it, or a folder inside Mousse data, compiles as file access', () => {
    for (const roots of [[files], [join(profile, 'bots')], [join(files, 'sub')]]) {
      const named = compile({ grant: { ...botStarterManifest(), workspace: { roots, access: 'write' } } })
      if (!named.ok) throw new Error(named.error.message)
      expect(named.permissions.workspace, roots[0]).toMatchObject({ files: realpathSync(files), computer: { closed: profile } })
    }
  })

  it('must be where Mousse keeps bots\' files', () => {
    expect(compile({ filesFolder: notes })).toMatchObject({ ok: false, error: { code: 'policy_unenforceable' } })
    expect(compile({ filesFolder: join(profile, 'bots', 'files') })).toMatchObject({ ok: false })
  })

  it('without one, a grant with no folder has no file access at all, as before', () => {
    const compiled = compile({ filesFolder: undefined })
    if (!compiled.ok) throw new Error(compiled.error.message)
    expect(compiled.permissions.workspace).toBeNull()
  })
})

describe('memory tools on every bot thread', () => {
  it('come with the bot tools, whatever the stored grant says', () => {
    const old = { ...botStarterManifest(), appTools: ['web_search'] }
    const compiled = compile({ grant: old, botTools: { escalate: true, consult: false, memory: true } })
    if (!compiled.ok) throw new Error(compiled.error.message)
    for (const tool of BOT_MEMORY_TOOLS) {
      expect(compiled.permissions.appTools).toContain(tool)
      expect(compiled.policy.tools?.allow).toContain(tool)
    }
    const without = compile({ grant: old, botTools: { escalate: true, consult: false } })
    if (!without.ok) throw new Error(without.error.message)
    expect(without.permissions.appTools).toEqual(['escalate', 'web_search'])
  })
})

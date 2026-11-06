import { describe, expect, it, vi } from 'vitest'
import { COMPOSER_COMMANDS, filterComposerCommandSuggestions, parseComposerCommand } from '../src/shared/composerCommands'
import { SLASH_COMMANDS, runSlashCommand, type SlashCommandEnv } from '../src/renderer/lib/slashCommands'

function env(overrides: Partial<SlashCommandEnv> = {}): SlashCommandEnv {
  return {
    threadId: 'thread-1',
    turnActive: false,
    hasAttachments: false,
    openUsage: vi.fn(),
    stop: vi.fn(async () => {}),
    steer: vi.fn(async () => true),
    newThread: vi.fn(async () => {}),
    clearContext: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    fork: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    openRename: vi.fn(() => true),
    ...overrides
  }
}

describe('composer command registry', () => {
  it('gives every command a name, a hint and an argument rule, and runs every one but /skills', () => {
    for (const command of COMPOSER_COMMANDS) {
      expect(command.name).toMatch(/^[a-z]+$/)
      expect(command.description.length).toBeGreaterThan(0)
      expect(['none', 'optional', 'required']).toContain(command.argument)
      if (command.argument === 'none') expect(command.argsHint).toBeUndefined()
      if (command.argument === 'required') expect(command.argsHint).toBeTruthy()
    }
    const names = COMPOSER_COMMANDS.map((command) => command.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...SLASH_COMMANDS.keys()].sort()).toEqual(names.filter((name) => name !== 'skills').sort())
  })

  it('lists the new commands in the / picker', () => {
    expect(filterComposerCommandSuggestions('/').map((command) => command.name)).toEqual(
      expect.arrayContaining(['clear', 'compact', 'fork', 'rename', 'new', 'usage', 'stop', 'steer', 'skills'])
    )
    expect(filterComposerCommandSuggestions('/co').map((command) => command.name)).toEqual(['compact'])
    expect(filterComposerCommandSuggestions('/compact ')).toEqual([])
  })
})

describe('parseComposerCommand', () => {
  it('reads the name in any case and the trimmed text after it', () => {
    expect(parseComposerCommand('  /Rename   New title  ')).toMatchObject({ command: { name: 'rename' }, argument: 'New title' })
    expect(parseComposerCommand('/compact keep the API notes\nand the plan')?.argument).toBe('keep the API notes\nand the plan')
    expect(parseComposerCommand('/clear')).toMatchObject({ command: { name: 'clear' }, argument: '' })
  })

  it('leaves ordinary text and unknown commands alone', () => {
    expect(parseComposerCommand('clear the cache')).toBeNull()
    expect(parseComposerCommand('/clearall')).toBeNull()
    expect(parseComposerCommand('/review this')).toBeNull()
    expect(parseComposerCommand('a /clear')).toBeNull()
  })
})

describe('runSlashCommand', () => {
  it('returns null for text that is not a command', async () => {
    expect(await runSlashCommand('hello', env())).toBeNull()
    expect(await runSlashCommand('/skills', env())).toBeNull()
  })

  it('keeps the commands that predate the registry as they were', async () => {
    const e = env()
    expect(await runSlashCommand('/usage', e)).toEqual({ kind: 'done' })
    expect(e.openUsage).toHaveBeenCalled()
    // Text after /usage, or attachments, make it a message.
    expect(await runSlashCommand('/usage please', env())).toBeNull()
    expect(await runSlashCommand('/usage', env({ hasAttachments: true }))).toBeNull()
    expect(await runSlashCommand('/new', env({ hasAttachments: true }))).toBeNull()

    const stop = env({ turnActive: true, hasAttachments: true })
    expect(await runSlashCommand('/stop now', stop)).toEqual({ kind: 'done' })
    expect(stop.stop).toHaveBeenCalled()

    const created = env({ threadId: null })
    expect(await runSlashCommand('/new Release notes', created)).toEqual({ kind: 'done' })
    expect(created.newThread).toHaveBeenCalledWith('Release notes')
    await runSlashCommand('/new', created)
    expect(created.newThread).toHaveBeenLastCalledWith(undefined)
  })

  it('/steer steers, keeps an empty one, and sends the text when no turn takes it', async () => {
    const e = env({ turnActive: true })
    expect(await runSlashCommand('/steer use the other file', e)).toEqual({ kind: 'done' })
    expect(e.steer).toHaveBeenCalledWith('use the other file')
    expect(await runSlashCommand('/steer', e)).toEqual({ kind: 'keep' })
    expect(await runSlashCommand('/steer later', env({ steer: vi.fn(async () => false) }))).toEqual({ kind: 'send', text: 'later' })
  })

  it('/clear starts a fresh session on the thread', async () => {
    const e = env()
    expect(await runSlashCommand('/clear', e)).toEqual({ kind: 'done' })
    expect(e.clearContext).toHaveBeenCalledWith('thread-1')
    expect(await runSlashCommand('/clear everything', env())).toEqual({ kind: 'refused', message: '/clear takes no text.' })
  })

  it('/compact passes the focus along', async () => {
    const e = env()
    await runSlashCommand('/compact', e)
    expect(e.compact).toHaveBeenLastCalledWith('thread-1', undefined)
    await runSlashCommand('/compact keep the test plan', e)
    expect(e.compact).toHaveBeenLastCalledWith('thread-1', 'keep the test plan')
  })

  it('/fork forks the thread', async () => {
    const e = env()
    expect(await runSlashCommand('/fork', e)).toEqual({ kind: 'done' })
    expect(e.fork).toHaveBeenCalledWith('thread-1')
  })

  it('/rename renames, opens the rename box, or shows the hint', async () => {
    const e = env()
    await runSlashCommand('/rename Login bug', e)
    expect(e.rename).toHaveBeenCalledWith('thread-1', 'Login bug')
    expect(await runSlashCommand('/rename', e)).toEqual({ kind: 'done' })
    expect(e.openRename).toHaveBeenCalledWith('thread-1')
    expect(await runSlashCommand('/rename', env({ openRename: () => false }))).toEqual({
      kind: 'refused',
      message: 'Type a title: /rename <title>'
    })
  })

  it('refuses /clear, /compact and /fork while a turn runs, and lets /rename through', async () => {
    for (const name of ['clear', 'compact', 'fork']) {
      const e = env({ turnActive: true })
      expect(await runSlashCommand(`/${name}`, e)).toEqual({ kind: 'refused', message: `Wait for the turn to finish to use /${name}.` })
    }
    const e = env({ turnActive: true })
    expect(await runSlashCommand('/rename Busy', e)).toEqual({ kind: 'done' })
  })

  it('refuses the thread commands on a blank chat and with attachments', async () => {
    expect(await runSlashCommand('/compact', env({ threadId: null }))).toEqual({ kind: 'refused', message: 'Send a message first, then /compact.' })
    expect(await runSlashCommand('/fork', env({ hasAttachments: true }))).toEqual({ kind: 'refused', message: 'Remove the attachments to use /fork.' })
  })

  it('reports a failed command in one line', async () => {
    const e = env({ clearContext: vi.fn(async () => { throw new Error("Error invoking remote method 'threads:clearContext': Error: Thread not found\nstack") }) })
    expect(await runSlashCommand('/clear', e)).toEqual({ kind: 'refused', message: 'Thread not found' })
  })
})

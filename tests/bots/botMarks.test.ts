/**
 * The marks this computer keeps on bots (`bots.marks.*`, `bot-marks.json`): pin, hide, mute and marked unread for its
 * own bots and the other computers' alike, asked for by a window of this computer only, kept across a restart, and
 * dropped with a bot of this computer that is gone for good. A bot of another computer that is lost takes its marks
 * with it in `tests/net/bridge/routed/remoteBotRegistry.test.ts`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The next writes of the marks file that fail, as a full disk would. */
const writes = vi.hoisted(() => ({ fail: 0 }))
vi.mock('../../src/mms/data/AtomicFs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/mms/data/AtomicFs')>()
  return {
    ...real,
    atomicWriteJsonSync: (...args: Parameters<typeof real.atomicWriteJsonSync>) => {
      if (writes.fail > 0) {
        writes.fail -= 1
        throw new Error('The disk is full.')
      }
      return real.atomicWriteJsonSync(...args)
    }
  }
})
import { BOT_MARKS_FILE, BotMarksStore } from '../../src/mms/bots/marks/BotMarksStore'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { PROTOCOL_METHODS } from '../../src/mms/protocol/types'
import { BOT_MARK_METHODS } from '../../src/shared/bots/personal/marks'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-marks-'))
  dirs.push(dir)
  return join(dir, 'bots')
}

const NODE = `nod_${'a'.repeat(26)}`
const REMOTE = `${NODE}:inbox-helper`
const T0 = Date.parse('2026-11-28T09:00:00.000Z')

describe('the marks on disk', () => {
  it('are kept across a restart, an earlier pin keeps its time, and a bot with no marks left has no entry', () => {
    const dir = folder()
    let now = T0
    const store = new BotMarksStore(dir, () => now)
    store.set('desk-helper', 'pinned', true)
    now += 60_000
    store.set('desk-helper', 'pinned', true)
    store.set(REMOTE, 'hidden', true)
    store.set(REMOTE, 'muted', true)
    store.set('desk-helper', 'unread', true)
    const again = new BotMarksStore(dir)
    expect(again.list()).toEqual({ 'desk-helper': { pinnedAt: '2026-11-28T09:00:00.000Z', unread: true }, [REMOTE]: { hidden: true, muted: true } })
    again.set(REMOTE, 'hidden', false)
    again.set(REMOTE, 'muted', false)
    expect(JSON.parse(readFileSync(join(dir, BOT_MARKS_FILE), 'utf8'))).toEqual({ version: 1, bots: { 'desk-helper': { pinnedAt: '2026-11-28T09:00:00.000Z', unread: true } } })
  })

  it('reads nothing until first used, and makes no file for a read', () => {
    const dir = folder()
    const store = new BotMarksStore(dir)
    expect(store.list()).toEqual({})
    expect(existsSync(join(dir, BOT_MARKS_FILE))).toBe(false)
  })

  it('treats a file it can\'t read as no marks, and puts it aside on the first change', () => {
    const dir = folder()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, BOT_MARKS_FILE), '{ not json')
    const store = new BotMarksStore(dir)
    expect(store.list()).toEqual({})
    store.set('desk-helper', 'muted', true)
    expect(new BotMarksStore(dir).list()).toEqual({ 'desk-helper': { muted: true } })
    expect(readdirSync(dir).filter((name) => name.startsWith(`${BOT_MARKS_FILE}.corrupt-`))).toHaveLength(1)
  })

  it('drops the marks of one computer\'s bots, or of all of them, and of this computer\'s bots that are gone', () => {
    const store = new BotMarksStore(folder())
    const other = `nod_${'b'.repeat(26)}:art-helper`
    for (const ref of [REMOTE, `${NODE}:runner`, other, 'desk-helper', 'gone-bot']) store.set(ref, 'muted', true)
    expect(store.dropBots(NODE, ['inbox-helper'])).toBe(true)
    expect(Object.keys(store.list()).sort()).toEqual([`${NODE}:runner`, 'desk-helper', 'gone-bot', other].sort())
    expect(store.dropComputer(NODE)).toBe(true)
    expect(store.dropLocal((botId) => botId === 'desk-helper')).toBe(true)
    expect(Object.keys(store.list()).sort()).toEqual(['desk-helper', other].sort())
    expect(store.dropComputer(NODE)).toBe(false)
  })

  it('drops the marks of every computer not kept, at once or when the file is first read', () => {
    const dir = folder()
    const other = `nod_${'b'.repeat(26)}:art-helper`
    const store = new BotMarksStore(dir)
    for (const ref of [REMOTE, other, 'desk-helper']) store.set(ref, 'muted', true)
    store.keepComputers((node) => node === NODE)
    expect(Object.keys(store.list()).sort()).toEqual([REMOTE, 'desk-helper'].sort())
    // A start: the computers are known before the marks are first read.
    const again = new BotMarksStore(dir)
    again.keepComputers(() => false)
    expect(again.list()).toEqual({ 'desk-helper': { muted: true } })
    expect(new BotMarksStore(dir).list()).toEqual({ 'desk-helper': { muted: true } })
  })

  it('keeps no change it could not write, so the same change is written whole when tried again', () => {
    const dir = folder()
    const store = new BotMarksStore(dir)
    store.set(REMOTE, 'muted', true)
    writes.fail = 1
    expect(() => store.set('desk-helper', 'pinned', true)).toThrow('The disk is full.')
    expect(store.list()).toEqual({ [REMOTE]: { muted: true } })
    store.set('desk-helper', 'pinned', true)
    expect(Object.keys(new BotMarksStore(dir).list()).sort()).toEqual([REMOTE, 'desk-helper'].sort())
    writes.fail = 1
    expect(() => store.dropComputer(NODE)).toThrow('The disk is full.')
    expect(store.dropComputer(NODE)).toBe(true)
    expect(new BotMarksStore(dir).list()).toEqual({ 'desk-helper': { pinnedAt: expect.any(String) } })
  })

  it('never writes over a file there that it can\'t read: it is set aside on the first change', () => {
    const dir = folder()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, BOT_MARKS_FILE)
    const saved = JSON.stringify({ version: 1, bots: { 'desk-helper': { muted: true } } })
    writeFileSync(file, saved)
    chmodSync(file, 0o000)
    const store = new BotMarksStore(dir)
    expect(store.list()).toEqual({})
    store.set(REMOTE, 'pinned', true)
    const aside = readdirSync(dir).filter((name) => name.startsWith(`${BOT_MARKS_FILE}.corrupt-`))
    expect(aside).toHaveLength(1)
    chmodSync(join(dir, aside[0]), 0o600)
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe(saved)
    expect(Object.keys(new BotMarksStore(dir).list())).toEqual([REMOTE])
  })
})

describe('bots.marks.list and bots.marks.set', () => {
  const setup = (bots: string[] = ['desk-helper'], listed: string[] = [REMOTE]) => {
    const botMarks = new BotMarksStore(folder())
    const emit = vi.fn()
    const botRouter = { list: () => listed.map((id) => ({ id })) }
    const mms = { botMarks, events: { emit }, botRouter, personalBots: { botName: (botId: string) => (bots.includes(botId) ? 'A bot' : undefined) } }
    const connection = (over: Record<string, unknown> = {}) => ({ id: 'conn-1', clientType: 'gui', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>(), ...over })
    const call = (method: string, params: unknown, conn = connection()) => dispatchMethod({ mms, connection: conn } as unknown as HandlerContext, method, params)
    return { botMarks, emit, call, connection }
  }

  it('are protocol methods a window may call', () => {
    for (const method of BOT_MARK_METHODS) expect(PROTOCOL_METHODS as readonly string[]).toContain(method)
  })

  it('sets a mark on this computer\'s bot or another computer\'s, answers every mark, and tells the other windows', async () => {
    const { call, emit } = setup()
    expect(await call('bots.marks.set', { botId: REMOTE, mark: 'hidden', on: true })).toEqual({ marks: { [REMOTE]: { hidden: true } } })
    expect(await call('bots.marks.set', { botId: 'desk-helper', mark: 'muted', on: true })).toEqual({ marks: { [REMOTE]: { hidden: true }, 'desk-helper': { muted: true } } })
    expect(emit).toHaveBeenCalledWith({ channel: 'protocol:event', data: { type: 'bots.changed', data: { marks: true } } })
    expect(await call('bots.marks.list', {})).toEqual({ marks: { [REMOTE]: { hidden: true }, 'desk-helper': { muted: true } } })
  })

  it('are a window\'s of this computer only: a command line, another computer and the renderer\'s bridge are refused', async () => {
    const { call, connection, botMarks } = setup()
    for (const stranger of [connection({ clientType: 'cli' }), connection({ clientType: 'bridge' }), connection({ bridgeCaller: { node: NODE, user: 'u', maxPermissionMode: 'ask' } })]) {
      await expect(call('bots.marks.set', { botId: 'desk-helper', mark: 'pinned', on: true }, stranger)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(call('bots.marks.list', {}, stranger)).rejects.toMatchObject({ code: 'forbidden' })
    }
    expect(botMarks.list()).toEqual({})
  })

  it('refuses what is not a bot, a mark it does not know, and an on that is not true or false', async () => {
    const { call, botMarks } = setup()
    for (const params of [
      { botId: 't_thread', mark: 'pinned', on: true },
      { botId: 'nod_short:inbox-helper', mark: 'pinned', on: true },
      { botId: 'desk-helper', mark: 'starred', on: true },
      { botId: 'desk-helper', mark: 'pinned', on: 'yes' },
      { botId: 'desk-helper', mark: 'pinned', on: true, extra: 1 }
    ]) await expect(call('bots.marks.set', params)).rejects.toMatchObject({ code: 'invalid_params' })
    expect(botMarks.list()).toEqual({})
  })

  it('marks another computer\'s bot only while it is listed here, and always clears a mark', async () => {
    const { call, botMarks, emit } = setup(['desk-helper'], [])
    botMarks.set(REMOTE, 'hidden', true)
    await expect(call('bots.marks.set', { botId: REMOTE, mark: 'pinned', on: true })).rejects.toMatchObject({ code: 'bot_not_found' })
    expect(botMarks.list()).toEqual({ [REMOTE]: { hidden: true } })
    expect(emit).not.toHaveBeenCalled()
    expect(await call('bots.marks.set', { botId: REMOTE, mark: 'hidden', on: false })).toEqual({ marks: {} })
  })

  it('drops the marks of this computer\'s bots that are gone for good when listed, and keeps the other computers\'', async () => {
    const { call, botMarks } = setup(['desk-helper'])
    for (const ref of ['desk-helper', 'gone-bot', REMOTE]) botMarks.set(ref, 'pinned', true)
    expect(Object.keys(((await call('bots.marks.list', {})) as { marks: object }).marks).sort()).toEqual(['desk-helper', REMOTE].sort())
  })
})

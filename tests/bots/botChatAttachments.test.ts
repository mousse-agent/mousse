/**
 * The files the owner sends with a chat message (`bots.chat.send` attachments): copied into the
 * bot's files folder under `attachments/<date>/`, with a safe name and never over another file; a
 * pasted file first waits in the temporary folder, as it has no path of its own.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyBotAttachments, removeBotAttachments } from '../../src/mms/bots/chat/attachments'
import { chatInput } from '../../src/mms/bots/chat/BotChatService'
import { stageBotAttachment } from '../../src/main/ipc/botAttachments'
import { attachmentFileName } from '../../src/shared/bots/personal/attachments'
import { MAX_BOT_CHAT_ATTACHMENT_BYTES } from '../../src/shared/bots/personal/methods'

let base: string
let files: string
const at = new Date(2026, 10, 8, 21, 30).getTime()
const day = () => join(files, 'attachments', '2026-11-08')
/** A file the owner keeps somewhere, with `content`. */
function owned(name: string, content: string): { name: string; path: string } {
  const path = join(base, 'owner', name)
  writeFileSync(path, content)
  return { name, path }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bot-attachments-'))
  files = join(base, 'files')
  mkdirSync(join(base, 'owner'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('copyBotAttachments', () => {
  it('copies each file under attachments/<date>/, keeping the name the owner gave and the original', () => {
    const pdf = owned('march.pdf', '%PDF')
    const saved = copyBotAttachments(files, [pdf, owned('paste-1.png', 'png')], at)
    expect(saved).toEqual([{ name: 'march.pdf', path: join(day(), 'march.pdf') }, { name: 'paste-1.png', path: join(day(), 'paste-1.png') }])
    expect(readFileSync(join(day(), 'march.pdf'), 'utf8')).toBe('%PDF')
    expect(readFileSync(pdf.path, 'utf8')).toBe('%PDF')
  })

  it('never overwrites: a name taken that day gets (2), (3) before its extension', () => {
    copyBotAttachments(files, [owned('notes.md', 'one')], at)
    const [second, third] = copyBotAttachments(files, [owned('notes.md', 'two'), { name: 'notes.md', path: join(base, 'owner', 'notes.md') }], at)
    expect(second!.path).toBe(join(day(), 'notes (2).md'))
    expect(third!.path).toBe(join(day(), 'notes (3).md'))
    expect(readFileSync(join(day(), 'notes.md'), 'utf8')).toBe('one')
  })

  it('keeps every copy inside the folder, whatever the name says', () => {
    const file = owned('keys', 'x')
    const saved = copyBotAttachments(files, [{ name: '../../.ssh/authorized_keys', path: file.path }, { name: '..\\..\\boot.ini', path: file.path }], at)
    expect(saved.map((entry) => entry.path)).toEqual([join(day(), 'authorized_keys'), join(day(), 'boot.ini')])
    // The message still names the files as the owner did.
    expect(saved.map((entry) => entry.name)).toEqual(['../../.ssh/authorized_keys', '..\\..\\boot.ini'])
  })

  it('copies nothing when one file is gone, a folder or too large', () => {
    const kept = owned('kept.txt', 'kept')
    expect(() => copyBotAttachments(files, [kept, { name: 'gone.txt', path: join(base, 'owner', 'gone.txt') }], at)).toThrow('gone.txt is no longer there.')
    expect(() => copyBotAttachments(files, [kept, { name: 'owner', path: join(base, 'owner') }], at)).toThrow('owner is a folder. Attach the files in it instead.')
    expect(() => readdirSync(day())).toThrow()
  })

  it('removes copies made for a message that was never recorded', () => {
    const saved = copyBotAttachments(files, [owned('a.txt', 'a')], at)
    removeBotAttachments(saved)
    expect(readdirSync(day())).toEqual([])
  })
})

describe('attachmentFileName', () => {
  it('drops folders and characters file systems refuse, and never leaves an empty or reserved name', () => {
    expect(attachmentFileName('a/b/report.pdf')).toBe('report.pdf')
    expect(attachmentFileName('what?: "this" <one>|*.txt')).toBe('what__ _this_ _one___.txt')
    expect(attachmentFileName('..')).toBe('file')
    expect(attachmentFileName('  .hidden.  ')).toBe('hidden')
    expect(attachmentFileName('CON.txt')).toBe('_CON.txt')
  })
})

describe('chatInput', () => {
  it('lists the copies after the owner\'s words, or alone', () => {
    const saved = [{ name: 'list.txt', path: '/p/bots/files/b1/attachments/2026-11-08/list.txt' }]
    expect(chatInput('Sum these up', saved)).toBe('Sum these up\n\nAttached files:\n- list.txt: /p/bots/files/b1/attachments/2026-11-08/list.txt')
    expect(chatInput('', saved)).toBe('Attached files:\n- list.txt: /p/bots/files/b1/attachments/2026-11-08/list.txt')
    expect(chatInput('Hi', [])).toBe('Hi')
  })
})

describe('stageBotAttachment', () => {
  it('writes a pasted file to its own temporary folder and returns its path', () => {
    const path = stageBotAttachment(base, 'paste-1.png', new Uint8Array([137, 80, 78, 71]), at)
    expect(dirname(dirname(path))).toBe(join(base, 'mousse-bot-attachments'))
    expect([...readFileSync(path)]).toEqual([137, 80, 78, 71])
    // The same name again never overwrites the first.
    expect(stageBotAttachment(base, 'paste-1.png', new Uint8Array([1]), at)).not.toBe(path)
    expect(stageBotAttachment(base, '../../evil.sh', new Uint8Array([1]), at)).toMatch(/[\\/]evil\.sh$/)
  })

  it('takes only a name and bytes up to the limit', () => {
    expect(() => stageBotAttachment(base, '', new Uint8Array([1]), at)).toThrow('A pasted file needs a name.')
    expect(() => stageBotAttachment(base, 'a.png', 'not bytes', at)).toThrow('A pasted file needs its bytes.')
    expect(() => stageBotAttachment(base, 'big.png', { byteLength: 1 }, at)).toThrow('A pasted file needs its bytes.')
    expect(() => stageBotAttachment(base, 'big.png', new Uint8Array(MAX_BOT_CHAT_ATTACHMENT_BYTES + 1), at)).toThrow('big.png is larger than 50 MB.')
  })

  it('clears what earlier pastes left more than a day ago', () => {
    const old = stageBotAttachment(base, 'old.png', new Uint8Array([1]), at)
    const day = 24 * 60 * 60 * 1000
    utimesSync(dirname(old), new Date(at - 2 * day), new Date(at - 2 * day))
    const recent = stageBotAttachment(base, 'recent.png', new Uint8Array([1]), at)
    stageBotAttachment(base, 'next.png', new Uint8Array([1]), at)
    expect(readdirSync(join(base, 'mousse-bot-attachments'))).not.toContain(old.split(/[\\/]/).at(-2))
    expect(readdirSync(join(base, 'mousse-bot-attachments'))).toContain(recent.split(/[\\/]/).at(-2))
  })
})

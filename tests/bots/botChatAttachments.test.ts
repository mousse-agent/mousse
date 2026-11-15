/**
 * The files the owner sends with a chat message (`bots.chat.send` attachments): copied into the
 * bot's files folder under `attachments/<date>/`, with a safe name and never over another file; a
 * pasted file first waits in the temporary folder, as it has no path of its own.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyBotAttachments, removeBotAttachments } from '../../src/mms/bots/chat/attachments'
import { chatInput } from '../../src/mms/bots/chat/BotChatService'
import { stageBotAttachment, stageThreadAttachment } from '../../src/main/ipc/botAttachments'
import { MAX_STAGED_FILE_BYTES } from '../../src/shared/attachedFilesMarker'
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

describe('stageThreadAttachment', () => {
  it("writes a pasted file into its thread's temporary folder, under a unique name, and returns its path", async () => {
    const path = await stageThreadAttachment(base, 't-1', 'clip.mp4', new Uint8Array([0, 0, 0, 24]), at)
    expect(dirname(path)).toBe(join(base, 'mousse-attachments', 't-1'))
    expect(basename(path)).toMatch(/^[0-9a-f]{8}-clip\.mp4$/)
    expect([...readFileSync(path)]).toEqual([0, 0, 0, 24])
    // The same name again never overwrites the first.
    expect(await stageThreadAttachment(base, 't-1', 'clip.mp4', new Uint8Array([1]), at)).not.toBe(path)
    // A thread not made yet gets the `new` folder.
    expect(dirname(await stageThreadAttachment(base, undefined, 'a.txt', new Uint8Array([1]), at))).toBe(join(base, 'mousse-attachments', 'new'))
  })

  it('keeps every write inside the thread folder, whatever the name or thread id says', async () => {
    const folder = join(base, 'mousse-attachments', 't-1')
    for (const name of ['../../evil.sh', '..\\..\\evil.sh', '/etc/passwd', 'C:\\Windows\\evil.dll', 'con.txt', 'a<b>:c?.mp4', '..']) {
      expect(dirname(await stageThreadAttachment(base, 't-1', name, new Uint8Array([1]), at))).toBe(folder)
    }
    for (const thread of ['../t', 't/../../x', 'a\\b', '.']) {
      await expect(stageThreadAttachment(base, thread, 'a.txt', new Uint8Array([1]), at)).rejects.toThrow('A pasted file needs a thread.')
    }
    expect(readdirSync(join(base, 'mousse-attachments')).sort()).toEqual(['t-1'])
  })

  it('takes only a name and bytes up to the limit', async () => {
    await expect(stageThreadAttachment(base, 't-1', '', new Uint8Array([1]), at)).rejects.toThrow('A pasted file needs a name.')
    await expect(stageThreadAttachment(base, 't-1', 'a.mp4', 'not bytes', at)).rejects.toThrow('A pasted file needs its bytes.')
    await expect(stageThreadAttachment(base, 't-1', 'big.mp4', { byteLength: MAX_STAGED_FILE_BYTES + 1 }, at)).rejects.toThrow('A pasted file needs its bytes.')
    await expect(stageThreadAttachment(base, 't-1', 'big.mp4', new Uint8Array(MAX_STAGED_FILE_BYTES + 1), at)).rejects.toThrow('big.mp4 is larger than 200 MB.')
  })

  it("clears a thread's folder a week after its last paste", async () => {
    const old = await stageThreadAttachment(base, 'old', 'a.txt', new Uint8Array([1]), at)
    const recent = await stageThreadAttachment(base, 'recent', 'b.txt', new Uint8Array([1]), at)
    const day = 24 * 60 * 60 * 1000
    utimesSync(dirname(old), new Date(at - 8 * day), new Date(at - 8 * day))
    utimesSync(dirname(recent), new Date(at - 6 * day), new Date(at - 6 * day))
    await stageThreadAttachment(base, 'next', 'c.txt', new Uint8Array([1]), at)
    expect(readdirSync(join(base, 'mousse-attachments')).sort()).toEqual(['next', 'recent'])
  })
})

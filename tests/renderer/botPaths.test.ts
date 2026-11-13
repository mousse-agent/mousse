/**
 * Paths in a bot's message become file links, drawn as chips (botPaths.ts): which text is a path, which is left as
 * written, and what each chip reads.
 */
import { describe, expect, it } from 'vitest'
import { botFileHref, botPathLabel, linkBotPaths } from '../../src/renderer/components/bots/botPaths'

const FILES = 'C:\\Users\\me\\.mousse\\profiles\\d9d018ad-5de0\\bots\\files\\bot-8f8f'
const link = (path: string, name = path.split(/[\\/]/).at(-1)!) => `[${name}](${botFileHref(path)})`

describe('linkBotPaths', () => {
  // [what, the bot wrote, what the chat reads]
  const rows: Array<[string, string, string]> = [
    ['a bare Windows path after a label', `Picture (1600 × 1200): ${FILES}\\chip-clouds-boy.png`, `Picture (1600 × 1200): ${link(`${FILES}\\chip-clouds-boy.png`)}`],
    ['a full stop after it stays text', `Saved to ${FILES}\\notes.md.`, `Saved to ${link(`${FILES}\\notes.md`)}.`],
    ['a closing bracket it never opened stays text', `(see ${FILES}\\a.txt)`, `(see ${link(`${FILES}\\a.txt`)})`],
    ['forward slashes on a drive', 'C:/work/plan.md', link('C:/work/plan.md')],
    ['a network path', '\\\\nas\\share\\report.pdf', link('\\\\nas\\share\\report.pdf')],
    ['a home path', 'Open /home/me/notes/todo.md now', `Open ${link('/home/me/notes/todo.md')} now`],
    ['a macOS path', '/Users/me/Desktop/shot.png', link('/Users/me/Desktop/shot.png')],
    ['a code span that is one path', `\`${FILES}\\make.py\``, link(`${FILES}\\make.py`)],
    ['a code span with more than a path stays code', `\`python ${FILES}\\make.py\``, `\`python ${FILES}\\make.py\``],
    ['a fenced block stays as written', `\`\`\`\n${FILES}\\make.py\n\`\`\``, `\`\`\`\n${FILES}\\make.py\n\`\`\``],
    ['a Markdown link keeps its own target', `[the plan](${FILES}\\plan.md)`, `[the plan](${FILES}\\plan.md)`],
    ['a web address is not a path', 'https://example.com/home/me/x', 'https://example.com/home/me/x'],
    ['and/or and a network size are text', 'Use and/or with a /24 network', 'Use and/or with a /24 network'],
    ['a drive alone is not a file', 'Free space on C:\\ is low', 'Free space on C:\\ is low'],
    ['a list item keeps its marker', `- ${FILES}\\a.png`, `- ${link(`${FILES}\\a.png`)}`]
  ]
  it.each(rows)('%s', (_what, written, read) => {
    expect(linkBotPaths(written)).toBe(read)
  })

  it('the link holds the whole path, which a code span may hold with spaces', () => {
    expect(linkBotPaths(`\`${FILES}\\my notes.md\``)).toBe(`[my notes.md](${botFileHref(`${FILES}\\my notes.md`)})`)
    expect(decodeURIComponent(botFileHref(`${FILES}\\a b.png`).split('path=')[1]!)).toBe(`${FILES}\\a b.png`)
  })
})

describe('botPathLabel', () => {
  it('reads a file in the bot’s files folder as its path there, never the profile, and any other file as its name', () => {
    expect(botPathLabel(`${FILES}\\chip-clouds-boy.png`, 'bot-8f8f')).toBe('chip-clouds-boy.png')
    expect(botPathLabel(`${FILES}\\attachments\\2026-11-13\\notes.md`, 'bot-8f8f')).toBe('attachments/2026-11-13/notes.md')
    expect(botPathLabel(`${FILES}\\notes.md`, 'another-bot')).toBe('notes.md')
    expect(botPathLabel('/home/me/Desktop/shot.png', 'bot-8f8f')).toBe('shot.png')
  })
})

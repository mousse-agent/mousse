/**
 * Which pictures of a bot's reply show above its words, and what its words keep (botReplyImages.ts).
 */
import { describe, expect, it } from 'vitest'
import { replyImages } from '../../src/renderer/components/bots/botReplyImages'

const FILES = 'C:\\Users\\me\\.mousse\\profiles\\d9d0\\bots\\files\\bot-8f8f'
const DATA = 'data:image/png;base64,iVBORw0KGgo='

describe('replyImages', () => {
  // [what, the reply's words, its files, the pictures' keys, the words kept]
  const rows: Array<[string, string, Array<{ name: string; path: string }>, string[], string]> = [
    ['a picture it made, as Markdown', `Here it is.\n\n![a boy on a chip](file:///C:/Users/me/out/boy.png)`, [], ['C:/Users/me/out/boy.png'], 'Here it is.'],
    ['a path to a picture stays its chip, and shows above', `Picture: ${FILES}\\boy.png`, [], [`${FILES}\\boy.png`], `Picture: ${FILES}\\boy.png`],
    ['a picture it sent as a file', 'Done.', [{ name: 'boy.png', path: `${FILES}\\boy.png` }, { name: 'make.py', path: `${FILES}\\make.py` }], [`${FILES}\\boy.png`], 'Done.'],
    ['the same picture three ways is one', `![](${FILES}\\boy.png)\n${FILES}\\boy.png`, [{ name: 'boy.png', path: `${FILES}\\boy.png` }], [`${FILES}\\boy.png`], `${FILES}\\boy.png`],
    ['several, in the order they come, words before files', `![a](/home/me/a.png) ![b](/home/me/b.jpg)\n\nThe third: \`/home/me/c.webp\``, [{ name: 'd.gif', path: '/home/me/d.gif' }], ['/home/me/a.png', '/home/me/b.jpg', '/home/me/c.webp', '/home/me/d.gif'], 'The third: `/home/me/c.webp`'],
    ['a data: picture', `![chart](${DATA})`, [], [DATA], ''],
    ['a path in angle brackets, with spaces', '![take](<C:\\Users\\me\\My pictures\\take 1.png>)', [], ['C:\\Users\\me\\My pictures\\take 1.png'], ''],
    ['a web picture stays a link', '![logo](https://example.com/logo.png)', [], [], '![logo](https://example.com/logo.png)'],
    ['an SVG is no picture', `Code: ${FILES}\\boy.svg`, [], [], `Code: ${FILES}\\boy.svg`],
    ['a file that is not a picture', `Notes: ${FILES}\\notes.md`, [], [], `Notes: ${FILES}\\notes.md`],
    ['fenced code is left as written', '```md\n![x](/home/me/x.png)\n```', [], [], '```md\n![x](/home/me/x.png)\n```']
  ]
  it.each(rows)('%s', (_what, text, attachments, keys, kept) => {
    const { images, text: words } = replyImages({ text, attachments })
    expect(images.map((image) => image.key)).toEqual(keys)
    expect(words).toBe(kept)
  })

  it('names a picture by its alt text, else by its file name', () => {
    expect(replyImages({ text: '![a boy](/home/me/a.png) ![](/home/me/b.png)' }).images.map((image) => image.name)).toEqual(['a boy', 'b.png'])
  })
})

/**
 * Thread titles: the title model sees a small cleaned summary of the thread, never code, logs or tool
 * output, and its answer becomes a name that fits the sidebar (about 26 characters at its default width).
 */
import { describe, expect, it } from 'vitest'
import { formatChatReferences } from '../../src/shared/chatReferences'
import {
  buildTitlePrompt,
  cleanTitleText,
  fitTitle,
  heuristicTitle,
  normalizeTitle,
  replyGist,
  TITLE_MAX_CHARS,
  TITLE_PROMPT_BUDGET,
  TITLE_SYSTEM_PROMPT,
  titleContextOf,
  titleLength
} from '../../src/shared/threadTitleText'

const stackTrace = [
  'TypeError: Cannot read properties of undefined (reading \'id\')',
  '    at reconnect (src/mms/bridge/link.ts:120:14)',
  '    at Timeout._onTimeout (src/mms/bridge/link.ts:88:5)',
  '    at listOnTimeout (node:internal/timers:573:17)',
  '    at process.processTimers (node:internal/timers:514:7)'
].join('\n')

describe('cleaning what the title model sees', () => {
  it('drops fenced code, including a fence that never closes, and names it in the hints', () => {
    const closed = cleanTitleText(`fix this\n\`\`\`ts\n${'const a = 1\n'.repeat(300)}\`\`\`\nit crashes on save`)
    expect(closed.text).toBe('fix this it crashes on save')
    expect(closed.hints.omitted).toContain('code')
    const open = cleanTitleText(`why does this fail\n\`\`\`\n${'x();\n'.repeat(50)}`)
    expect(open.text).toBe('why does this fail')
  })

  it('keeps the words before a pasted stack trace and leaves the trace out', () => {
    const { text, hints } = cleanTitleText(`getting this on startup:\n${stackTrace}`)
    expect(text).toBe('getting this on startup:')
    expect(hints.omitted).toContain('stack trace')
  })

  it('leaves out a pasted log paragraph but keeps a single error line someone typed', () => {
    const log = Array.from({ length: 8 }, (_, i) => `2026-11-09 10:0${i}:00 ERROR relay closed`).join('\n')
    expect(cleanTitleText(`the relay keeps dropping\n\n${log}`).text).toBe('the relay keeps dropping')
    expect(cleanTitleText('TypeError: x is undefined in the bridge').text).toBe('TypeError: x is undefined in the bridge')
  })

  it('keeps a Markdown list, which is not a diff', () => {
    expect(cleanTitleText('- add retries\n- log failures\n- show a toast').text).toBe('add retries log failures show a toast')
  })

  it('removes reference data, attached-file and voice markers and browser HTML, and keeps file names as hints', () => {
    const references = formatChatReferences([{ kind: 'file', title: 'ThreadsSidebar.tsx', path: 'src/renderer/components/ThreadsSidebar.tsx' }])
    const content = [
      references,
      '[Attached files: notes.pdf, C:\\Users\\me\\Desktop\\shot.png]',
      '[Voice message (0:12)]',
      '[Selected browser element]\nURL: http://localhost:5173/\nHTML: <div class="row">' + 'x'.repeat(4000) + '</div>\n[/Selected browser element]',
      'make the row title shorter'
    ].join('\n')
    const { text, hints } = cleanTitleText(content)
    expect(text).toBe('make the row title shorter')
    expect(hints.files).toEqual(['ThreadsSidebar.tsx', 'notes.pdf', 'shot.png'])
    expect(hints.browserElement).toBe(true)
    expect(text).not.toContain('data=')
  })

  it('turns paths into file names and links into hosts, and leaves "and/or" alone', () => {
    const { text } = cleanTitleText('see C:\\work\\mousse\\src\\main\\index.ts and https://github.com/mousse-agent/mousse/pull/373?x=1 and/or src/a/b.ts')
    expect(text).toBe('see index.ts and github.com and/or b.ts')
  })

  it('reads a leading command as the command, with its arguments as the topic', () => {
    const { text, hints } = cleanTitleText('/review the login changes')
    expect(hints.skill).toBe('review')
    expect(text).toBe('the login changes')
  })

  it('stays within its budget, cut at a word', () => {
    const { text } = cleanTitleText('word '.repeat(1000))
    expect(titleLength(text)).toBeLessThanOrEqual(500)
    expect(text.endsWith('word')).toBe(true)
  })
})

describe('the opening of a reply', () => {
  it('skips a leading diff and keeps the first prose, within 300 characters', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '@@ -1,3 +1,3 @@', '-const a = 1', '+const a = 2', ' const b = 3'].join('\n')
    const gist = replyGist(`${diff}\n\nI replaced the heuristic with a cleaner. ${'More detail follows here. '.repeat(40)}`)
    expect(gist.startsWith('I replaced the heuristic with a cleaner.')).toBe(true)
    expect(titleLength(gist)).toBeLessThanOrEqual(300)
  })
})

describe('the prompt', () => {
  it('holds the request, the reply opening and hints, and no code, within the budget', () => {
    const prompt = buildTitlePrompt({
      request: `fix this\n\`\`\`ts\n${'x'.repeat(4000)}\n\`\`\``,
      later: ['continue', 'now also retry the failed checkout'],
      reply: `${'```\ncode\n```\n'.repeat(50)}The checkout retries stop after one failure. ${'y '.repeat(3000)}`,
      images: 2
    })
    expect(prompt).toContain('Request: fix this')
    expect(prompt).toContain('Later request: now also retry the failed checkout')
    expect(prompt).not.toContain('Later request: continue')
    expect(prompt).toContain('Reply began: The checkout retries stop after one failure.')
    expect(prompt).toContain('Hints: 2 images; left out: code')
    expect(prompt).not.toContain('```')
    expect(TITLE_SYSTEM_PROMPT.length + prompt.length).toBeLessThanOrEqual(TITLE_PROMPT_BUDGET)
  })

  it('says when the request has no words of its own', () => {
    expect(buildTitlePrompt({ request: stackTrace + '\n' + stackTrace })).toContain('Request: (no words')
  })
})

describe('the model answer as a sidebar name', () => {
  it('strips labels, bullets, quotes, markdown and ending punctuation', () => {
    expect(normalizeTitle('Title: "Sidebar title clipping."')).toBe('Sidebar title clipping')
    expect(normalizeTitle('- **OAuth callback retries**\nBecause the user asked...')).toBe('OAuth callback retries')
  })

  it('drops a generic opener', () => {
    expect(normalizeTitle('Help with bridge reconnect')).toBe('Bridge reconnect')
  })

  it('fits the cap at a word, without a dangling stopword', () => {
    const title = normalizeTitle('Investigating why project groups disappear after restart on the other computer')!
    expect(titleLength(title)).toBeLessThanOrEqual(TITLE_MAX_CHARS)
    expect(title).toBe('Investigating why project')
  })

  it('names nothing for UNTITLED or an empty answer', () => {
    expect(normalizeTitle('UNTITLED')).toBeNull()
    expect(normalizeTitle('  "" ')).toBeNull()
  })

  it('keeps another language as written and counts an emoji or accent as one character', () => {
    expect(normalizeTitle('Corrigir recorte do título')).toBe('Corrigir recorte do título')
    expect(titleLength('é👍🏽')).toBe(2)
  })

  it('cuts one word longer than the cap at a character rather than showing nothing', () => {
    expect(fitTitle('x'.repeat(40))).toBe('x'.repeat(TITLE_MAX_CHARS))
  })
})

describe('the title from the message alone', () => {
  it('drops "please"/"can you" and uses the first sentence that names something', () => {
    expect(heuristicTitle('Hi! Can you fix the OAuth callback loop? It started yesterday.')).toBe('Fix the OAuth callback loop')
  })

  it('names nothing for "continue" or a paste alone, and falls back to the command or a file', () => {
    expect(heuristicTitle('continue')).toBe('')
    expect(heuristicTitle(stackTrace + '\n' + stackTrace)).toBe('')
    expect(heuristicTitle('/end-session')).toBe('End session')
    expect(heuristicTitle('[Attached files: budget.xlsx]')).toBe('budget.xlsx')
  })

  it('fits the sidebar', () => {
    expect(titleLength(heuristicTitle('Please make the sidebar thread titles shorter so they fit at the default width'))).toBeLessThanOrEqual(TITLE_MAX_CHARS)
  })
})

describe('what a title is made from', () => {
  it('takes the first request, later requests and the first finished reply, skipping tool rows and hidden input', () => {
    const context = titleContextOf([
      { role: 'user', content: 'internal wake', hidden: true },
      { role: 'user', content: 'fix the login redirect', images: [{} as never] },
      { role: 'assistant', content: 'Reading files', kind: 'tool_call' },
      { role: 'assistant', content: 'The redirect loses the state parameter.' },
      { role: 'user', content: 'also keep the return path' }
    ])
    expect(context).toEqual({
      request: 'fix the login redirect',
      later: ['also keep the return path'],
      reply: 'The redirect loses the state parameter.',
      images: 1
    })
  })

  it('is null before the person has written anything', () => {
    expect(titleContextOf([{ role: 'assistant', content: 'hi' }])).toBeNull()
  })
})

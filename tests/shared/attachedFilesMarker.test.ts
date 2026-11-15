import { describe, expect, it } from 'vitest'
import { formatAttachedFilesMarker, parseAttachedFilesList, replaceAttachedFilesMarkers, type AttachedFileEntry } from '../../src/shared/attachedFilesMarker'

/** The entries of the one marker in `text`, as a reader of the message gets them back. */
function readBack(text: string): AttachedFileEntry[] {
  const found: AttachedFileEntry[] = []
  const rest = replaceAttachedFilesMarkers(text, (entries) => {
    found.push(...entries)
    return ''
  })
  expect(rest.trim()).toBe('look at these')
  return found
}

describe('the attached-files marker', () => {
  // Paths a person's files really have: spaces, commas, parentheses, brackets, a `), ` inside a folder name,
  // drive letters with either slash, a network share, and POSIX.
  const rows: Array<[string, AttachedFileEntry[]]> = [
    ['one Windows file', [{ name: 'a.mp4', path: 'C:\\Users\\me\\Videos\\a.mp4' }]],
    ['two files, Windows and POSIX', [{ name: 'a.mp4', path: 'C:\\clips\\a.mp4' }, { name: 'b.pdf', path: '/tmp/mousse-attachments/t1/1a2b3c4d-b.pdf' }]],
    ['spaces and parentheses', [{ name: 'clip (1).mp4', path: 'C:\\My Videos (old)\\clip (1).mp4' }, { name: 'x.txt', path: '/home/me/x.txt' }]],
    ['commas in the name and the folder', [{ name: 'a, b.mov', path: '/Users/me/Movies, 2026/a, b.mov' }, { name: 'c.pdf', path: '/tmp/c.pdf' }]],
    ['brackets, and a path ending in one', [{ name: 'notes [draft].md', path: '/srv/[team]/notes [draft].md' }, { name: 'z]', path: '/tmp/z]' }]],
    ['a "), " inside a folder name', [{ name: 'f.mp4', path: '/data/a), b/f.mp4' }]],
    ['forward slashes on a drive, and a share', [{ name: 'a.mkv', path: 'D:/media/a.mkv' }, { name: 'b.wav', path: '\\\\nas\\share\\b.wav' }]]
  ]
  it.each(rows)('reads back %s', (_label, entries) => {
    const text = `look at these\n\n${formatAttachedFilesMarker(entries)}\n\n`
    expect(readBack(text)).toEqual(entries)
    // The marker is also the last paragraph of a message, with nothing after it.
    expect(readBack(`look at these\n\n${formatAttachedFilesMarker(entries)}`)).toEqual(entries)
  })

  it('writes the path after each name, as the model reads it', () => {
    expect(formatAttachedFilesMarker([{ name: 'a.mp4', path: 'C:\\clips\\a.mp4' }, { name: 'b.pdf', path: '/tmp/b.pdf' }]))
      .toBe('[Attached files: a.mp4 (C:\\clips\\a.mp4), b.pdf (/tmp/b.pdf)]')
    expect(formatAttachedFilesMarker([])).toBe('')
  })

  it('keeps a name on one line, so it cannot end the marker', () => {
    const entries = [{ name: 'two\nlines].txt', path: '/tmp/x.txt' }]
    expect(readBack(`look at these\n\n${formatAttachedFilesMarker(entries)}`)).toEqual([{ name: 'two lines].txt', path: '/tmp/x.txt' }])
  })

  it('still reads markers sent before paths were added: names only, and inside a line', () => {
    expect(parseAttachedFilesList('notes.md, clip (1).mp4')).toEqual([{ name: 'notes.md' }, { name: 'clip (1).mp4' }])
    expect(parseAttachedFilesList('notes.pdf, C:\\Users\\me\\Desktop\\shot.png')).toEqual([{ name: 'notes.pdf' }, { name: 'C:\\Users\\me\\Desktop\\shot.png' }])
    const names: string[] = []
    const rest = replaceAttachedFilesMarkers('see [Attached files: a.txt] and [Attached files: b.txt, c.txt]\nthanks', (entries) => {
      names.push(...entries.map((entry) => entry.name))
      return ''
    })
    expect(names).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(rest).toBe('see  and \nthanks')
  })
})

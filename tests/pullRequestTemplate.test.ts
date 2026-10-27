import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PULL_REQUEST_TEMPLATE_MAX_BYTES, readPullRequestTemplate } from '../src/mms/git/pullRequestTemplate'

describe('pull request template', () => {
  let root: string

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mousse-pr-template-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is null when the repository has none', async () => {
    expect(await readPullRequestTemplate(root)).toBeNull()
  })

  it.each([
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md'
  ])('reads %s', async (path) => {
    write(path, '## Summary\n')
    expect(await readPullRequestTemplate(root)).toBe('## Summary\n')
  })

  it('prefers .github/, then the root, then docs/', async () => {
    write('docs/pull_request_template.md', 'docs')
    expect(await readPullRequestTemplate(root)).toBe('docs')
    write('PULL_REQUEST_TEMPLATE.md', 'root')
    expect(await readPullRequestTemplate(root)).toBe('root')
    write('.github/pull_request_template.md', 'github')
    expect(await readPullRequestTemplate(root)).toBe('github')
  })

  it.each([
    '.github/PULL_REQUEST_TEMPLATE/default.md',
    'PULL_REQUEST_TEMPLATE/default.md',
    'docs/PULL_REQUEST_TEMPLATE/default.md'
  ])('reads the one template of the folder %s', async (path) => {
    write(path, 'only one')
    expect(await readPullRequestTemplate(root)).toBe('only one')
  })

  it('takes the first Markdown file, alphabetically, of a folder with several', async () => {
    write('.github/PULL_REQUEST_TEMPLATE/feature.md', 'feature')
    write('.github/PULL_REQUEST_TEMPLATE/bugfix.md', 'bugfix')
    write('.github/PULL_REQUEST_TEMPLATE/notes.txt', 'not markdown')
    expect(await readPullRequestTemplate(root)).toBe('bugfix')
  })

  it('prefers a single-file template over a folder', async () => {
    write('.github/PULL_REQUEST_TEMPLATE/a.md', 'folder')
    write('docs/pull_request_template.md', 'file')
    expect(await readPullRequestTemplate(root)).toBe('file')
  })

  it('skips an empty file', async () => {
    write('.github/pull_request_template.md', '  \n')
    write('pull_request_template.md', 'root')
    expect(await readPullRequestTemplate(root)).toBe('root')
  })

  it('keeps at most 4 KB, without leaving half a character', async () => {
    write('pull_request_template.md', 'a'.repeat(PULL_REQUEST_TEMPLATE_MAX_BYTES * 3))
    expect((await readPullRequestTemplate(root))?.length).toBe(PULL_REQUEST_TEMPLATE_MAX_BYTES)
    write('docs/pull_request_template.md', `${'a'.repeat(PULL_REQUEST_TEMPLATE_MAX_BYTES - 1)}é and more`)
    rmSync(join(root, 'pull_request_template.md'))
    const text = await readPullRequestTemplate(root)
    expect(text).toBe('a'.repeat(PULL_REQUEST_TEMPLATE_MAX_BYTES - 1))
  })

  describe('a linked folder', () => {
    let outside: string

    /** A junction on Windows (no special rights needed), a symlink elsewhere. */
    const linkFolder = (target: string, path: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      symlinkSync(target, join(root, path), 'junction')
    }

    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), 'mousse-pr-template-outside-'))
    })
    afterEach(() => {
      rmSync(outside, { recursive: true, force: true })
    })

    it('is not followed out of the repository for .github/ or docs/', async () => {
      writeFileSync(join(outside, 'pull_request_template.md'), 'OUTSIDE PRIVATE CONTENT')
      linkFolder(outside, '.github')
      expect(await readPullRequestTemplate(root)).toBeNull()
      linkFolder(outside, 'docs')
      expect(await readPullRequestTemplate(root)).toBeNull()
    })

    it('is not followed out of the repository for a PULL_REQUEST_TEMPLATE/ folder', async () => {
      writeFileSync(join(outside, 'one.md'), 'OUTSIDE PRIVATE CONTENT')
      linkFolder(outside, '.github/PULL_REQUEST_TEMPLATE')
      expect(await readPullRequestTemplate(root)).toBeNull()
    })

    it('skips the escaping link and still finds a real template further down the list', async () => {
      writeFileSync(join(outside, 'pull_request_template.md'), 'OUTSIDE PRIVATE CONTENT')
      linkFolder(outside, '.github')
      write('docs/pull_request_template.md', 'inside')
      expect(await readPullRequestTemplate(root)).toBe('inside')
    })

    it('is followed when it stays inside the repository', async () => {
      write('shared/pull_request_template.md', 'shared inside')
      linkFolder(join(root, 'shared'), '.github')
      expect(await readPullRequestTemplate(root)).toBe('shared inside')
    })
  })

  it('does not follow a link out of the repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mousse-pr-template-outside-'))
    try {
      writeFileSync(join(outside, 'secret.md'), 'secret')
      mkdirSync(join(root, '.github'))
      try {
        symlinkSync(join(outside, 'secret.md'), join(root, '.github', 'pull_request_template.md'))
      } catch {
        // Creating links needs a privilege on some systems; nothing to check there.
        return
      }
      expect(await readPullRequestTemplate(root)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

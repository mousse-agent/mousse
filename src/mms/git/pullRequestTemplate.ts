import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** A template longer than this is cut: it only seeds a description. */
export const PULL_REQUEST_TEMPLATE_MAX_BYTES = 4 * 1024

const TEMPLATE_FILES = ['pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md']
/** Where GitHub looks, in its order: `.github/`, the repository root, then `docs/`. */
const TEMPLATE_DIRECTORIES = ['.github', '', 'docs']
const TEMPLATE_FOLDER = 'PULL_REQUEST_TEMPLATE'

/** True when `path` is `root` or inside it; Windows paths compare without regard to case. */
function isInside(root: string, path: string): boolean {
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(root)
  const target = fold(path)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * The first bytes of a plain, non-empty file that really lives inside the repository, or null. The
 * path is resolved through every link on the way (a linked `.github` or `docs` folder, a link to a
 * file), so a repository cannot make a template out of a file elsewhere on the disk.
 */
async function readTemplateFile(realRoot: string, path: string): Promise<string | null> {
  try {
    const real = await realpath(path)
    if (!isInside(realRoot, real) || !(await stat(real)).isFile()) return null
    const handle = await open(real, 'r')
    try {
      const buffer = Buffer.alloc(PULL_REQUEST_TEMPLATE_MAX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      // A cut can split a multi-byte character; drop what it leaves behind.
      const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/�+$/, '')
      return text.trim() ? text : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** The first Markdown file of a `PULL_REQUEST_TEMPLATE/` folder, alphabetically (the only one, when there is one). */
async function readTemplateFolder(realRoot: string, folder: string): Promise<string | null> {
  let names: string[]
  try {
    const realFolder = await realpath(folder)
    if (!isInside(realRoot, realFolder)) return null
    names = await readdir(realFolder)
    folder = realFolder
  } catch {
    return null
  }
  for (const name of names.filter((entry) => /\.md$/i.test(entry)).sort()) {
    const text = await readTemplateFile(realRoot, join(folder, name))
    if (text !== null) return text
  }
  return null
}

/**
 * The repository's pull request template, read from a checkout: the single-file names in
 * `.github/`, the root and `docs/`, then a `PULL_REQUEST_TEMPLATE/` folder in the same three
 * places. At most 4 KB, so a long template cannot crowd out the rest of a draft. Only files that
 * resolve, links included, to a place inside the checkout are read.
 */
export async function readPullRequestTemplate(root: string): Promise<string | null> {
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return null
  }
  for (const directory of TEMPLATE_DIRECTORIES) {
    for (const name of TEMPLATE_FILES) {
      const text = await readTemplateFile(realRoot, join(root, directory, name))
      if (text !== null) return text
    }
  }
  for (const directory of TEMPLATE_DIRECTORIES) {
    const text = await readTemplateFolder(realRoot, join(root, directory, TEMPLATE_FOLDER))
    if (text !== null) return text
  }
  return null
}

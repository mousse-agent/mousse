import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** A template longer than this is cut: it only seeds a description. */
export const PULL_REQUEST_TEMPLATE_MAX_BYTES = 4 * 1024

const TEMPLATE_FILES = ['pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md']
/** Where GitHub looks, in its order: `.github/`, the repository root, then `docs/`. */
const TEMPLATE_DIRECTORIES = ['.github', '', 'docs']
const TEMPLATE_FOLDER = 'PULL_REQUEST_TEMPLATE'

/** The file's first bytes as text, or null for anything that is not a plain, non-empty file (a link could point outside the repository). */
async function readTemplateFile(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null
    const handle = await open(path, 'r')
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
async function readTemplateFolder(folder: string): Promise<string | null> {
  let names: string[]
  try {
    names = await readdir(folder)
  } catch {
    return null
  }
  for (const name of names.filter((entry) => /\.md$/i.test(entry)).sort()) {
    const text = await readTemplateFile(join(folder, name))
    if (text !== null) return text
  }
  return null
}

/**
 * The repository's pull request template, read from a checkout: the single-file names in
 * `.github/`, the root and `docs/`, then a `PULL_REQUEST_TEMPLATE/` folder in the same three
 * places. At most 4 KB, so a long template cannot crowd out the rest of a draft.
 */
export async function readPullRequestTemplate(root: string): Promise<string | null> {
  for (const directory of TEMPLATE_DIRECTORIES) {
    for (const name of TEMPLATE_FILES) {
      const text = await readTemplateFile(join(root, directory, name))
      if (text !== null) return text
    }
  }
  for (const directory of TEMPLATE_DIRECTORIES) {
    const text = await readTemplateFolder(join(root, directory, TEMPLATE_FOLDER))
    if (text !== null) return text
  }
  return null
}

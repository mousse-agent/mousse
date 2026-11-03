import { readFile, stat } from 'fs/promises'
import { dirname, extname, join, normalize, posix, relative, resolve, sep } from 'path'
import type { SimpleGit } from 'simple-git'

export interface BlastRadiusResult {
  declaredFiles: string[]
  prospectiveFiles: string[]
  includedFiles: string[]
  dependencyFiles: string[]
  dependentFiles: string[]
  supportFiles: string[]
  rejectedFiles: Array<{ path: string; reason: string }>
}

const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.py', '.go', '.rs'
]

const SUPPORT_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml',
  'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.json', 'deno.jsonc',
  'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js',
  'vitest.config.ts', 'vitest.config.js', 'electron.vite.config.ts',
  'AGENTS.md', '.gitignore'
])

function gitPath(value: string): string {
  return value.split(sep).join('/')
}

function normalizeDeclaredPath(root: string, value: string): string | null {
  const absolute = resolve(root, value)
  const rel = relative(root, absolute)
  if (!rel || rel === '.') return null
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== absolute) return null
  return gitPath(normalize(rel))
}

function candidatePaths(importer: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier))
  const candidates = [base]
  if (!extname(base)) {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`)
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}/index${extension}`)
    candidates.push(`${base}.json`)
  }
  return candidates
}

export function extractRelativeSpecifiers(content: string): string[] {
  const found = new Set<string>()
  const patterns = [
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /(?:require|import)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /@(?:use|import)\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /(?:src|href)\s*=\s*['"](\.{1,2}\/[^'"?#]+)[^'"]*['"]/g
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) if (match[1]) found.add(match[1])
  }
  return [...found]
}

function closure(seeds: Iterable<string>, edges: Map<string, Set<string>>): Set<string> {
  const result = new Set(seeds)
  const queue = [...result]
  while (queue.length) {
    const current = queue.shift()!
    for (const next of edges.get(current) ?? []) {
      if (result.has(next)) continue
      result.add(next)
      queue.push(next)
    }
  }
  return result
}

/**
 * Builds a conservative source dependency graph from tracked files. Both dependencies
 * and dependents are included transitively so edits retain their compilation and test blast radius.
 */
/** Source files read together. */
const READ_BATCH = 256

/** A tracked source file's text, or undefined when it is not there, is over 2 MiB, or cannot be read. */
async function sourceText(absolute: string): Promise<string | undefined> {
  try {
    if ((await stat(absolute)).size > 2 * 1024 * 1024) return undefined
    return await readFile(absolute, 'utf8')
  } catch {
    return undefined
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((found) => found.isDirectory(), () => false)
}

export class BlastRadiusAnalyzer {
  constructor(private readonly root: string, private readonly git: SimpleGit) {}

  async analyze(requestedFiles: string[]): Promise<BlastRadiusResult> {
    const tracked = new Set(
      (await this.git.raw(['ls-files', '-z'])).split('\0').filter(Boolean).map((file) => gitPath(file))
    )
    const declaredFiles: string[] = []
    const rejectedFiles: BlastRadiusResult['rejectedFiles'] = []
    for (const requested of requestedFiles) {
      const normalized = normalizeDeclaredPath(this.root, requested)
      if (!normalized) {
        rejectedFiles.push({ path: requested, reason: 'Path must identify a file inside the repository.' })
      } else if (/[*?\[\]{}]/.test(normalized)) {
        rejectedFiles.push({ path: requested, reason: 'Globs are not allowed; declare exact file paths.' })
      } else if (await isDirectory(join(this.root, ...normalized.split('/')))) {
        rejectedFiles.push({ path: requested, reason: 'Directories are not allowed; declare exact file paths.' })
      } else if (!declaredFiles.includes(normalized)) {
        declaredFiles.push(normalized)
      }
    }
    if (declaredFiles.length === 0) throw new Error('At least one repository file must be declared for editing.')

    const forward = new Map<string, Set<string>>()
    const reverse = new Map<string, Set<string>>()
    const sources = [...tracked].filter((file) => SOURCE_EXTENSIONS.includes(extname(file).toLowerCase()))
    // Read a batch at a time without blocking the daemon, then taken in the tracked files' order.
    const contents = new Map<string, string | undefined>()
    for (let start = 0; start < sources.length; start += READ_BATCH) {
      const batch = sources.slice(start, start + READ_BATCH)
      const read = await Promise.all(batch.map((file) => sourceText(join(this.root, ...file.split('/')))))
      batch.forEach((file, index) => contents.set(file, read[index]))
    }
    for (const file of sources) {
      try {
        const text = contents.get(file)
        if (text === undefined) continue
        const imports = extractRelativeSpecifiers(text)
        for (const specifier of imports) {
          const target = candidatePaths(file, specifier).find((candidate) => tracked.has(candidate))
          if (!target) continue
          if (!forward.has(file)) forward.set(file, new Set())
          if (!reverse.has(target)) reverse.set(target, new Set())
          forward.get(file)!.add(target)
          reverse.get(target)!.add(file)
        }
      } catch {
        // An unreadable tracked file is left out of the graph; declarations remain included.
      }
    }

    const dependencies = closure(declaredFiles, forward)
    const dependents = closure(declaredFiles, reverse)
    const support = new Set<string>()
    for (const file of tracked) {
      const name = posix.basename(file)
      if (SUPPORT_NAMES.has(name) && (!file.includes('/') || declaredFiles.some((entry) => entry.startsWith(`${posix.dirname(file)}/`)))) {
        support.add(file)
      }
    }
    for (const declared of declaredFiles) {
      let directory = posix.dirname(declared)
      while (directory && directory !== '.') {
        const instructions = `${directory}/AGENTS.md`
        if (tracked.has(instructions)) support.add(instructions)
        directory = posix.dirname(directory)
      }
    }

    const included = new Set([...dependencies, ...dependents, ...support])
    return {
      declaredFiles: declaredFiles.sort(),
      prospectiveFiles: declaredFiles.filter((file) => !tracked.has(file)).sort(),
      includedFiles: [...included].sort(),
      dependencyFiles: [...dependencies].filter((file) => !declaredFiles.includes(file)).sort(),
      dependentFiles: [...dependents].filter((file) => !declaredFiles.includes(file)).sort(),
      supportFiles: [...support].sort(),
      rejectedFiles
    }
  }
}

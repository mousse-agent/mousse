import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import type {
  IntegrationDiagnostic,
  SkillDescriptor,
  SkillReadResult,
  SkillsRegistrySnapshot,
  SkillSource,
  SkillSourceDescriptor
} from '../../../shared/integrations'
import { getSkillRootPaths, type SkillRootPathDescriptor } from '../../data/paths'

type UnknownRecord = Record<string, unknown>

export interface SkillsDiscoveryOptions {
  projectPath?: string
}

export class SkillsRegistry {
  private discoveryCache = new Map<string, { snapshot: SkillsRegistrySnapshot; fetchedAt: number }>()
  private static readonly DISCOVERY_TTL_MS = 30_000

  invalidateDiscoveryCache(): void {
    this.discoveryCache.clear()
  }

  async discover(options: SkillsDiscoveryOptions = {}): Promise<SkillsRegistrySnapshot> {
    const cacheKey = options.projectPath ?? ''
    const cached = this.discoveryCache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < SkillsRegistry.DISCOVERY_TTL_MS) {
      return cached.snapshot
    }

    const snapshot = await this.discoverUncached(options)
    this.discoveryCache.set(cacheKey, { snapshot, fetchedAt: Date.now() })
    return snapshot
  }

  private async discoverUncached(options: SkillsDiscoveryOptions = {}): Promise<SkillsRegistrySnapshot> {
    const sources = getSkillRootPaths(options.projectPath).map(
      (descriptor): SkillSourceDescriptor => ({
        ...descriptor,
        exists: existsSync(descriptor.path)
      })
    )

    const skills: SkillDescriptor[] = []
    const diagnostics: IntegrationDiagnostic[] = []

    for (const source of sources) {
      if (!source.exists) continue

      try {
        const skillFiles = await findSkillFiles(source.path)
        for (const skillPath of skillFiles) {
          const parsed = await this.readSkillDescriptor(source, skillPath)
          if (parsed.skill) skills.push(parsed.skill)
          diagnostics.push(...parsed.diagnostics)
        }
      } catch (err) {
        diagnostics.push({
          level: 'error',
          source: source.source,
          path: source.path,
          message: `Failed to scan Skills root: ${formatError(err)}`
        })
      }
    }

    const sortedSkills = skills.sort(compareSkills)
    const duplicateDiagnostics = markDuplicateSkills(sortedSkills)

    return {
      sources,
      skills: sortedSkills,
      diagnostics: [...diagnostics, ...duplicateDiagnostics]
    }
  }

  async readSkill(
    skillId: string,
    options: SkillsDiscoveryOptions = {},
    snapshot?: SkillsRegistrySnapshot
  ): Promise<SkillReadResult> {
    const resolved = snapshot ?? (await this.discover(options))
    const skill = resolved.skills.find((entry) => entry.id === skillId || entry.name === skillId)
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`)
    }
    return {
      skill,
      content: await readFile(skill.skillPath, 'utf-8')
    }
  }

  private async readSkillDescriptor(
    source: SkillRootPathDescriptor,
    skillPath: string
  ): Promise<{ skill?: SkillDescriptor; diagnostics: IntegrationDiagnostic[] }> {
    const diagnostics: IntegrationDiagnostic[] = []
    const content = await readFile(skillPath, 'utf-8')
    const frontmatter = parseFrontmatter(content)

    if (frontmatter.error) {
      diagnostics.push({
        level: 'warning',
        source: source.source,
        path: skillPath,
        message: frontmatter.error
      })
      return { diagnostics }
    }

    const name = stringValue(frontmatter.attributes.name)
    const description = stringValue(frontmatter.attributes.description)
    if (!name || !description) {
      diagnostics.push({
        level: 'warning',
        source: source.source,
        path: skillPath,
        message: 'Skill frontmatter must include name and description.'
      })
      return { diagnostics }
    }

    const rootPath = dirname(skillPath)
    const id = `${source.source}:${normalizePath(relative(source.path, rootPath)) || name}`
    return {
      diagnostics,
      skill: {
        id,
        name,
        description,
        rootPath,
        skillPath,
        scope: source.scope,
        source: source.source,
        paths: stringArrayValue(frontmatter.attributes.paths),
        'disable-model-invocation': booleanValue(
          frontmatter.attributes['disable-model-invocation']
        ),
        metadata: recordValue(frontmatter.attributes.metadata),
        compatibility:
          stringArrayValue(frontmatter.attributes.compatibility) ??
          recordValue(frontmatter.attributes.compatibility),
        hasScripts: existsSync(join(rootPath, 'scripts')),
        hasAssets: existsSync(join(rootPath, 'assets')),
        hasReferences: existsSync(join(rootPath, 'references'))
      }
    }
  }
}

async function findSkillFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)
    if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(entryPath)
      continue
    }
    if (entry.isDirectory()) {
      files.push(...(await findSkillFiles(entryPath)))
    }
  }

  return files
}

function parseFrontmatter(content: string): {
  attributes: UnknownRecord
  error?: string
} {
  if (!content.startsWith('---')) {
    return { attributes: {}, error: 'Skill file is missing YAML frontmatter.' }
  }

  const closeMatch = content.slice(3).match(/\r?\n---\s*(\r?\n|$)/)
  if (!closeMatch || closeMatch.index === undefined) {
    return { attributes: {}, error: 'Skill frontmatter is not closed.' }
  }

  const frontmatter = content.slice(3, closeMatch.index + 3)
  return { attributes: parseYamlSubset(frontmatter) }
}

function parseYamlSubset(raw: string): UnknownRecord {
  const attributes: UnknownRecord = {}
  const lines = raw.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue

    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim()
    const rest = stripYamlComment(line.slice(separatorIndex + 1).trim())
    if (rest) {
      attributes[key] = parseYamlScalar(rest)
      continue
    }

    const blockValues: string[] = []
    const blockObject: UnknownRecord = {}
    let isObject = false

    while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
      index += 1
      const child = stripYamlComment(lines[index].trim())
      if (!child) continue
      if (child.startsWith('- ')) {
        blockValues.push(String(parseYamlScalar(child.slice(2).trim())))
        continue
      }
      const childSeparatorIndex = child.indexOf(':')
      if (childSeparatorIndex !== -1) {
        isObject = true
        blockObject[child.slice(0, childSeparatorIndex).trim()] = parseYamlScalar(
          child.slice(childSeparatorIndex + 1).trim()
        )
      }
    }

    attributes[key] = isObject ? blockObject : blockValues
  }

  return attributes
}

function parseYamlScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner
      ? splitInlineList(inner).map((entry) => unquoteYamlString(entry.trim()))
      : []
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return unquoteYamlString(value)
}

function splitInlineList(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      current += char
      if (char === quote && value[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }

  if (current) parts.push(current)
  return parts
}

function stripYamlComment(value: string): string {
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return value.slice(0, index).trim()
  }
  return value
}

function unquoteYamlString(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"')
  }
  return value
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(String)
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function recordValue(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function compareSkills(a: SkillDescriptor, b: SkillDescriptor): number {
  return sourceRank(a.source) - sourceRank(b.source) || a.name.localeCompare(b.name)
}

function sourceRank(source: SkillSource): number {
  const ranks: Record<SkillSource, number> = {
    'cursor-project': 0,
    'agents-project': 1,
    'claude-project': 2,
    'codex-project': 3,
    'opencode-project': 4,
    'cursor-global': 5,
    'agents-global': 6,
    'claude-global': 7,
    'codex-global': 8,
    'opencode-global': 9,
    'generated-agent': 10
  }
  return ranks[source]
}

function markDuplicateSkills(skills: SkillDescriptor[]): IntegrationDiagnostic[] {
  const seen = new Map<string, SkillDescriptor>()
  const diagnostics: IntegrationDiagnostic[] = []

  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    const existing = seen.get(key)
    if (existing) {
      skill.isActive = false
      skill.duplicateOf = existing.id
      diagnostics.push({
        level: 'info',
        source: skill.source,
        path: skill.skillPath,
        targetId: skill.id,
        message: `Skill name also appears in ${existing.source}; higher-precedence skill remains active.`
      })
      continue
    }
    skill.isActive = true
    seen.set(key, skill)
  }

  return diagnostics
}

function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

import { existsSync, readdirSync, readFileSync } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import { homedir } from 'os'
import type { ModeDescriptor } from '../../shared/modes'

type UnknownRecord = Record<string, unknown>

export interface ModeDiscoveryOptions {
  projectPath?: string
}

function parseFrontmatter(content: string): { attributes: UnknownRecord; body: string; error?: string } {
  if (!content.startsWith('---')) {
    return { attributes: {}, body: content, error: 'Missing YAML frontmatter.' }
  }
  const closeMatch = content.slice(3).match(/\r?\n---\s*(\r?\n|$)/)
  if (!closeMatch || closeMatch.index === undefined) {
    return { attributes: {}, body: content, error: 'Frontmatter not closed.' }
  }
  const frontmatter = content.slice(3, closeMatch.index + 3)
  const bodyStart = 3 + closeMatch.index + 3 + closeMatch[0].length
  const body = content.slice(bodyStart).trimStart()
  return { attributes: parseYamlSubset(frontmatter), body }
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
        const ck = child.slice(0, childSeparatorIndex).trim()
        const cv = child.slice(childSeparatorIndex + 1).trim()
        if (cv) {
          blockObject[ck] = parseYamlScalar(stripYamlComment(cv))
        } else {
          const nested: Record<string, string> = {}
          while (index + 1 < lines.length && /^\s{2,}/.test(lines[index + 1])) {
            index += 1
            const nestedLine = stripYamlComment(lines[index].trim())
            if (!nestedLine) continue
            const nIdx = nestedLine.indexOf(':')
            if (nIdx !== -1) {
              nested[nestedLine.slice(0, nIdx).trim()] = String(parseYamlScalar(nestedLine.slice(nIdx + 1).trim()))
            }
          }
          if (Object.keys(nested).length > 0) blockObject[ck] = nested
          else blockObject[ck] = {}
        }
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
    return inner ? splitInlineList(inner).map((e) => unquoteYamlString(e.trim())) : []
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return unquoteYamlString(value)
}

function splitInlineList(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote) {
      current += ch
      if (ch === quote && value[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === ',') { parts.push(current); current = ''; continue }
    current += ch
  }
  if (current) parts.push(current)
  return parts
}

function stripYamlComment(value: string): string {
  let q: string | null = null
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (q) { if (ch === q && value[i - 1] !== '\\') q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; continue }
    if (ch === '#') return value.slice(0, i).trim()
  }
  return value
}

function unquoteYamlString(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).replace(/\\"/g, '"')
  return v
}

function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function getModeRootPaths(projectPath?: string): string[] {
  const roots: string[] = []
  const home = homedir()
  roots.push(join(home, '.mousse', 'modes'))
  roots.push(join(home, '.config', 'opencode', 'agents'))
  roots.push(join(home, '.agents', 'agents'))
  if (projectPath) {
    roots.push(join(projectPath, 'agents'))
    roots.push(join(projectPath, '.opencode', 'agents'))
    roots.push(join(projectPath, '.mousse', 'modes'))
    roots.push(join(projectPath, '.agents', 'agents'))
  }
  const repoAgents = findRepoAgentsRoot(projectPath)
  if (repoAgents && !roots.includes(repoAgents)) roots.push(repoAgents)
  return roots
}

function findRepoAgentsRoot(projectPath?: string): string | undefined {
  let dir = projectPath ? dirname(projectPath) : __dirname
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, 'agents')
    if (existsSync(candidate)) {
      try {
        const stat = readdirSync(candidate)
        if (stat.some((f) => f.endsWith('.md'))) return candidate
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  let probe = dirname(__dirname)
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(probe, '..', '..', 'agents')
    const abs = join(probe, candidate)
    if (existsSync(abs)) return abs
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  return undefined
}

function resolveBuiltinAgentsDir(): string | undefined {
  let dir = dirname(__dirname)
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, '..', '..', 'agents')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const builtinDir = resolveBuiltinAgentsDir()

function readModeFile(filePath: string, source: string, scope: string): ModeDescriptor | undefined {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const parsed = parseFrontmatter(content)
    const id = basename(filePath, '.md').toLowerCase()
    const name = stringValue(parsed.attributes.name) ?? id
    const description = stringValue(parsed.attributes.description) ?? ''
    const mode = (stringValue(parsed.attributes.mode as unknown as string) as ModeDescriptor['mode']) ?? 'primary'
    const color = stringValue(parsed.attributes.color as unknown as string)
    const hidden = parsed.attributes.hidden === true
    const permission = parsed.attributes.permission as ModeDescriptor['permission'] | undefined
    const tools = parsed.attributes.tools as ModeDescriptor['tools'] | undefined
    const model = stringValue(parsed.attributes.model as unknown as string)
    return {
      id,
      name,
      description,
      mode: mode as ModeDescriptor['mode'],
      prompt: parsed.body,
      permission: permission as Record<string, string | Record<string, string>> | undefined,
      tools: tools as Record<string, boolean> | undefined,
      model,
      color,
      hidden,
      scope,
      source,
      path: filePath,
    }
  } catch {
    return undefined
  }
}

export class ModeRegistry {
  private cache = new Map<string, { modes: ModeDescriptor[]; at: number }>()
  private static TTL_MS = 30_000

  discoverSync(options: ModeDiscoveryOptions = {}): ModeDescriptor[] {
    const key = options.projectPath ?? ''
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < ModeRegistry.TTL_MS) return cached.modes
    const modes = this.discoverUncachedSync(options)
    this.cache.set(key, { modes, at: Date.now() })
    return modes
  }

  private discoverUncachedSync(options: ModeDiscoveryOptions): ModeDescriptor[] {
    const roots = getModeRootPaths(options.projectPath)
    const seen = new Map<string, ModeDescriptor>()
    for (const root of roots) {
      if (!existsSync(root)) continue
      let entries: string[] = []
      try { entries = readdirSync(root) } catch { continue }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue
        const full = join(root, entry)
        const rel = relative(root, full)
        const source = root.includes('.config') ? 'opencode-global' : root.includes('.mousse') ? 'mousse' : 'project'
        const scope = root.includes(homedir()) ? 'global' : 'project'
        const desc = readModeFile(full, source, scope)
        if (!desc) continue
        const norm = desc.id.toLowerCase()
        if (!seen.has(norm)) seen.set(norm, desc)
      }
    }
    if (seen.size === 0 && builtinDir && existsSync(builtinDir)) {
      try {
        const entries = readdirSync(builtinDir)
        for (const entry of entries) {
          if (!entry.endsWith('.md')) continue
          const full = join(builtinDir, entry)
          const desc = readModeFile(full, 'builtin', 'global')
          if (!desc) continue
          if (!seen.has(desc.id)) seen.set(desc.id, desc)
        }
      } catch {}
    }
    const builtins = this.getBuiltinFallbacks()
    for (const fb of builtins) {
      if (!seen.has(fb.id)) seen.set(fb.id, fb)
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  getModeSync(id: string, options: ModeDiscoveryOptions = {}): ModeDescriptor | undefined {
    const modes = this.discoverSync(options)
    return modes.find((m) => m.id.toLowerCase() === id.toLowerCase())
  }

  listModeIdsSync(options: ModeDiscoveryOptions = {}): string[] {
    return this.discoverSync(options).map((m) => m.id)
  }

  private getBuiltinFallbacks(): ModeDescriptor[] {
    return [
      {
        id: 'agent',
        name: 'Agent',
        description: 'Delegating orchestrator',
        mode: 'primary',
        prompt: '',
        permission: { read: 'allow', edit: 'allow', bash: 'allow', task: 'allow', question: 'allow' },
        scope: 'global',
        source: 'builtin',
        path: 'builtin:agent',
      },
      {
        id: 'plan',
        name: 'Plan',
        description: 'Read-only planning',
        mode: 'primary',
        prompt: '',
        permission: { read: 'allow', grep: 'allow', glob: 'allow', list: 'allow', edit: 'deny', bash: 'deny' },
        scope: 'global',
        source: 'builtin',
        path: 'builtin:plan',
      },
      {
        id: 'build',
        name: 'Build',
        description: 'Direct implementation',
        mode: 'primary',
        prompt: '',
        permission: { read: 'allow', edit: 'allow', bash: 'allow' },
        scope: 'global',
        source: 'builtin',
        path: 'builtin:build',
      },
    ]
  }

  invalidate(): void {
    this.cache.clear()
  }
}

export const modeRegistry = new ModeRegistry()

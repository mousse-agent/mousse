import { parse as parseYaml, YAMLParseError } from 'yaml'

type UnknownRecord = Record<string, unknown>

export interface SkillFrontmatterParse {
  attributes: UnknownRecord
  body: string
  rawFrontmatter?: string
  error?: string
}

const YAML_PARSE_OPTIONS = {
  maxAliasCount: 32,
  uniqueKeys: true,
  strict: false,
  prettyErrors: true
} as const

export function splitSkillMarkdown(content: string): SkillFrontmatterParse {
  if (!content.startsWith('---')) {
    return { attributes: {}, body: content, error: 'Skill file is missing YAML frontmatter.' }
  }

  const closeMatch = content.slice(3).match(/\r?\n---\s*(\r?\n|$)/)
  if (!closeMatch || closeMatch.index === undefined) {
    return { attributes: {}, body: content, error: 'Skill frontmatter is not closed.' }
  }

  const rawFrontmatter = content.slice(3, closeMatch.index + 3)
  const bodyStart = 3 + closeMatch.index + closeMatch[0].length
  const body = content.slice(bodyStart)
  try {
    const parsed = parseYaml(rawFrontmatter, YAML_PARSE_OPTIONS)
    if (parsed == null) {
      return { attributes: {}, body, rawFrontmatter, error: 'Skill frontmatter is empty.' }
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        attributes: {},
        body,
        rawFrontmatter,
        error: 'Skill frontmatter must be a YAML mapping.'
      }
    }
    return { attributes: parsed as UnknownRecord, body, rawFrontmatter }
  } catch (err) {
    const message =
      err instanceof YAMLParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    return {
      attributes: {},
      body,
      rawFrontmatter,
      error: `Skill frontmatter YAML is invalid: ${message}`
    }
  }
}

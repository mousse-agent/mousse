/**
 * The one place a model's name is decided. Every listing names models in its own style (Claude
 * Code "Opus 5.5", the Anthropic catalog "Claude 3.5 Haiku", Codex an id when it has no display
 * name); `canonicalModelName` gives them one style, and `modelNameFromId` names a model no listing
 * names. Both are safe to apply twice.
 */

/** Claude's model families, which some listings name without the brand ("Sonnet 5.5"). */
const CLAUDE_FAMILIES = 'opus|sonnet|haiku|fable'
/** "Opus", "Claude Opus 5.5", "claude opus 5". */
const CLAUDE_FAMILY_FIRST = new RegExp(`^(?:claude\\s+)?(${CLAUDE_FAMILIES})(?:\\s+(\\d+(?:\\.\\d+)*))?$`, 'i')
/** The older order, version first: "Claude 3.5 Haiku". */
const CLAUDE_VERSION_FIRST = new RegExp(`^(?:claude\\s+)?(\\d+(?:\\.\\d+)*)\\s+(${CLAUDE_FAMILIES})$`, 'i')
/** Claude ids: "claude-haiku-5-5", "claude-3-5-haiku-20241022", "opus", "sonnet[1m]". */
const CLAUDE_ID = new RegExp(
  `^(?:claude-(?:(\\d+)(?:-(\\d{1,2}))?-)?)?(${CLAUDE_FAMILIES})(?:-(\\d{1,2})(?:-(\\d{1,2}))?(?![\\d.]))?(?:-\\d{8})?`,
  'i'
)
/** Endpoint suffixes an id can carry after the model: `@context`, `:speed`, `:effort`. */
const ID_SUFFIX = /[@:].*$/

/** Words a name keeps in a fixed spelling. */
const WORDS: Record<string, string> = {
  gpt: 'GPT',
  oss: 'OSS',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  openai: 'OpenAI',
  mini: 'Mini',
  it: 'IT'
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function claudeName(family: string, version: string | undefined): string {
  return `Claude ${capitalize(family)}${version ? ` ${version}` : ''}`
}

/** "Opus 5.5" → "Claude Opus 5.5", "Claude 3.5 Haiku" → "Claude Haiku 3.5"; other names unchanged. */
function canonicalHead(head: string): string {
  const familyFirst = CLAUDE_FAMILY_FIRST.exec(head)
  if (familyFirst) return claudeName(familyFirst[1]!, familyFirst[2])
  const versionFirst = CLAUDE_VERSION_FIRST.exec(head)
  if (versionFirst) return claudeName(versionFirst[2]!, versionFirst[1])
  return head
}

function word(part: string): string {
  const lower = part.toLowerCase()
  if (WORDS[lower]) return WORDS[lower]
  // Sizes and versions with a letter read in capitals: "120b" → "120B", "v4" → "V4".
  if (/^\d+[a-z]$/i.test(part) || /^v\d/i.test(part)) return part.toUpperCase()
  if (/^\d/.test(part)) return part
  return capitalize(part)
}

/**
 * A name for a model no listing names, from its id: "claude-haiku-5-5" → "Claude Haiku 5.5",
 * "gpt-6.1-sol" → "GPT-6.1 Sol", "gemini-3.5-flash" → "Gemini 3.5 Flash". The endpoint suffixes an
 * id may carry (`gpt-6.1-sol:low`) are not part of the name, and a vendor path is dropped
 * (`anthropic/claude-fable-5`). A Claude variant the id carries stays ("opus-fast" → "Claude Opus
 * (fast)") so two variants never read the same.
 */
export function modelNameFromId(id: string): string {
  const bare = id.replace(ID_SUFFIX, '').split('/').pop()!.trim()
  if (!bare) return id
  const claude = CLAUDE_ID.exec(bare)
  if (claude) {
    const version = claude[4] ? `${claude[4]}${claude[5] ? `.${claude[5]}` : ''}` : claude[1] ? `${claude[1]}${claude[2] ? `.${claude[2]}` : ''}` : undefined
    const variant = bare.slice(claude[0].length).replace(/^[-_[]+|\]$/g, '')
    return `${claudeName(claude[3]!, version)}${variant ? ` (${variant})` : ''}`
  }
  // OpenAI's reasoning series keep their own spelling ("o3", "o4-mini").
  if (/^o\d/i.test(bare)) return bare
  const gpt = /^gpt-([^-]+)(?:-(.+))?$/i.exec(bare)
  if (gpt) return [`GPT-${/^\d/.test(gpt[1]!) ? gpt[1] : word(gpt[1]!)}`, ...(gpt[2] ? gpt[2].split(/[-_]+/).map(word) : [])].join(' ')
  return bare.split(/[-_\s]+/).filter(Boolean).map(word).join(' ')
}

/**
 * The name a listing gives a model, in Mousse's one style: the brand first, then the family and
 * version ("Claude Opus 5.5"). What follows the name stays as listed: an alias or variant in
 * parentheses, a context after " @ ". A missing name, or one that is only the id, is named from the id.
 */
export function canonicalModelName(label: string | undefined, id: string): string {
  const text = label?.trim()
  if (!text || text === id || text === id.replace(ID_SUFFIX, '')) return modelNameFromId(id)
  const cut = [text.indexOf(' ('), text.indexOf(' @ ')].filter((index) => index > 0)
  const end = cut.length ? Math.min(...cut) : text.length
  return `${canonicalHead(text.slice(0, end))}${text.slice(end)}`
}

/**
 * A name where the maker's logo already shows beside it: "Claude Opus 5.5" → "Opus 5.5". Only a
 * brand that comes before a family name of its own is dropped ("GPT-6.1 Sol" stays whole).
 */
export function shortModelName(name: string): string {
  return name.replace(new RegExp(`^Claude\\s+(?=(?:${CLAUDE_FAMILIES})\\b)`, 'i'), '')
}

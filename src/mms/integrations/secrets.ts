const ENV_PATTERNS: Array<{ regex: RegExp; nameIndex: number }> = [
  { regex: /\$\{env:([A-Za-z_][A-Za-z0-9_]*)}/g, nameIndex: 1 },
  { regex: /\$\{([A-Za-z_][A-Za-z0-9_]*)}/g, nameIndex: 1 },
  { regex: /(^|[^A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)/g, nameIndex: 2 },
  { regex: /%([A-Za-z_][A-Za-z0-9_]*)%/g, nameIndex: 1 }
]

const SECRET_REF_PATTERN = /\$\{secret:([A-Za-z0-9_.-]+)}/g

export const REDACTED_VALUE = '[redacted]'

export interface IntegrationSecretAdapter {
  resolveEnv(value: string): string
  resolveSecretRef?(ref: string): string | undefined
}

export function createProcessEnvSecretAdapter(
  env: NodeJS.ProcessEnv = process.env
): IntegrationSecretAdapter {
  return {
    resolveEnv(value: string): string {
      return resolveEnvValue(value, env)
    },
    resolveSecretRef(ref: string): string | undefined {
      return env[ref]
    }
  }
}

export function extractEnvVariableReferences(value: string): string[] {
  const names = new Set<string>()
  for (const { regex, nameIndex } of ENV_PATTERNS) {
    regex.lastIndex = 0
    for (const match of value.matchAll(regex)) {
      names.add(match[nameIndex])
    }
  }
  return Array.from(names)
}

export function extractSecretReferences(value: string): string[] {
  const names = new Set<string>()
  SECRET_REF_PATTERN.lastIndex = 0
  for (const match of value.matchAll(SECRET_REF_PATTERN)) {
    names.add(match[1])
  }
  return Array.from(names)
}

export function containsEnvReference(value: string): boolean {
  return extractEnvVariableReferences(value).length > 0 || extractSecretReferences(value).length > 0
}

/** Every reference form, in one pattern: a value is read once, so the text a reference stands for is never read again. */
const ONE_PASS = /\$\{secret:([A-Za-z0-9_.-]+)}|\$\{env:([A-Za-z_][A-Za-z0-9_]*)}|\$\{([A-Za-z_][A-Za-z0-9_]*)}|(^|[^A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g

/**
 * `value` with its references replaced, in one pass: a secret's or a variable's own text is kept as it is, so a secret
 * holding `${HOME}` stays that text instead of taking a variable's value (#358).
 */
export function resolveEnvValue(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  secrets?: IntegrationSecretAdapter
): string {
  return value.replace(ONE_PASS, (_match, secret?: string, envName?: string, braced?: string, prefix?: string, bare?: string, percent?: string) => {
    if (secret !== undefined) return secrets?.resolveSecretRef?.(secret) ?? ''
    if (bare !== undefined) return `${prefix ?? ''}${env[bare] ?? ''}`
    return env[(envName ?? braced ?? percent)!] ?? ''
  })
}

export function resolveRecord(
  record: Record<string, string> | undefined,
  secrets: IntegrationSecretAdapter
): Record<string, string> {
  if (!record) return {}
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, secrets.resolveEnv(value)])
  )
}

export function missingReferences(
  record: Record<string, string> | undefined,
  secrets: IntegrationSecretAdapter,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (!record) return []
  const missing = new Set<string>()
  for (const value of Object.values(record)) {
    for (const name of extractEnvVariableReferences(value)) {
      if (!env[name]) missing.add(name)
    }
    for (const name of extractSecretReferences(value)) {
      if (!secrets.resolveSecretRef?.(name)) missing.add(`secret:${name}`)
    }
  }
  return Array.from(missing).sort()
}

export function redactRecord(
  record: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!record) return undefined
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      containsEnvReference(value) ? value : REDACTED_VALUE
    ])
  )
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(Authorization:\s*)\S+/gi, `$1${REDACTED_VALUE}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, `$1${REDACTED_VALUE}`)
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, `$1=${REDACTED_VALUE}`)
}

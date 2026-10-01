import type { IntegrationDiagnostic } from '../../../shared/integrations'

const UNSUPPORTED_TOML = [
  { pattern: /"""/, message: 'triple-quoted multiline strings' },
  { pattern: /'''/, message: "triple-quoted literal strings" },
  { pattern: /^\[\[/m, message: 'array-of-tables syntax' },
  { pattern: /\d{4}-\d{2}-\d{2}/, message: 'datetime values' },
  { pattern: /\b0x[0-9a-fA-F]+|\b0o[0-7]+|\b0b[01]+/, message: 'non-decimal integer prefixes' },
  { pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+\s*=/m, message: 'dotted keys outside tables' }
]

export function tomlSubsetDiagnostics(
  raw: string,
  sourcePath: string
): IntegrationDiagnostic[] {
  const found = UNSUPPORTED_TOML.filter((entry) => entry.pattern.test(raw)).map((entry) => entry.message)
  if (found.length === 0) return []
  return [
    {
      level: 'warning',
      source: 'codex-project',
      path: sourcePath,
      message:
        `Codex MCP TOML is parsed with a bounded subset, not a standards TOML parser. Unsupported constructs (${found.join(', ')}) were skipped. Request a dedicated TOML parser dependency for full compliance.`
    }
  ]
}

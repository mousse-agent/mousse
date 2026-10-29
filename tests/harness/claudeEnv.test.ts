/**
 * The sign-in and route variables of the shipped Claude Code (PR 2 §6, `claude:api`): read from the
 * bundled binary, so a Claude Code that adds a credential or route variable fails here until it is
 * classified (dropped for API-key entries, or reviewed as harmless in the fixture).
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isClaudeSignInVariable } from '../../src/mms/harness/claude/apiKey'

/** Names that look like a credential or a route and were reviewed as neither (tuning, sessions, proxies, telemetry). */
const REVIEWED: string[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'claudeEnvReviewed.json'), 'utf8'))

/** What makes a name worth a look: anything about keys, auth, accounts, routes, hosts or providers. */
const SUSPICIOUS = /TOKEN|KEY|AUTH|CRED|SECRET|OAUTH|BASE_URL|_USE_|PROFILE|IDENTITY|FEDERATION|HEADER|SOCKET|HOST|PROXY|ENDPOINT|URL|ACCOUNT|ORG|WORKSPACE|REGION|PROJECT|PROVIDER|GATEWAY|LOGIN|SESSION/

/** The bundled Claude Code binary of this platform, when it is installed. */
function bundledClaude(): string | undefined {
  const scope = join(__dirname, '..', '..', 'node_modules', '@anthropic-ai')
  if (!existsSync(scope)) return undefined
  for (const name of readdirSync(scope)) {
    if (!name.startsWith('claude-agent-sdk-')) continue
    for (const binary of ['claude.exe', 'claude']) {
      const path = join(scope, name, binary)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

/**
 * Every `ANTHROPIC_*` and `CLAUDE_CODE_*` name in a file, read in chunks. Some builds (Linux) keep a
 * name in a string table as the name, one tag byte and a NUL (`CLAUDE_CODE_MESSAGING_SOCKETP\0`):
 * a name seen only that way, whose name without the last character is found too, is that name.
 */
function variableNames(path: string): Set<string> {
  const names = new Set<string>()
  const untagged = new Set<string>()
  const fd = openSync(path, 'r')
  const chunk = Buffer.alloc(16 * 1024 * 1024)
  let carry = ''
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (!read) break
      const text = carry + chunk.toString('latin1', 0, read)
      for (const match of text.matchAll(/(?:ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]+/g)) {
        names.add(match[0])
        if (text[match.index + match[0].length] !== '\0') untagged.add(match[0])
      }
      // A name cut at the chunk's end is read again with the next chunk.
      carry = text.slice(-128)
    }
  } finally {
    closeSync(fd)
  }
  for (const name of names) if (!untagged.has(name) && names.has(name.slice(0, -1))) names.delete(name)
  return names
}

const binary = bundledClaude()

describe('Claude Code sign-in and route variables', () => {
  it('drops every way the shipped Claude Code signs in or is routed, and keeps tuning', () => {
    for (const name of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_UNIX_SOCKET',
      'ANTHROPIC_PROFILE', 'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_FEDERATION_RULE_ID',
      'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_GATEWAY_TOKEN', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
      'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_API_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_SOMETHING_NEW', 'CLAUDE_CONFIG_DIR', 'anthropic_auth_token'
    ]) expect(isClaudeSignInVariable(name), name).toBe(true)
    for (const name of ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_USE_POWERSHELL_TOOL', 'CLAUDE_CODE_IDLE_TOKEN_THRESHOLD', 'ANTHROPIC_MODEL', 'HTTPS_PROXY', 'PATH', 'AWS_PROFILE'])
      expect(isClaudeSignInVariable(name), name).toBe(false)
  })

  it.skipIf(!binary)('classifies every credential-like variable the bundled Claude Code reads', () => {
    const names = variableNames(binary!)
    // The scan found the variables (a format change would otherwise pass silently).
    expect(names.has('ANTHROPIC_API_KEY')).toBe(true)
    expect(names.has('CLAUDE_CODE_USE_BEDROCK')).toBe(true)
    const unreviewed = [...names].filter((name) => SUSPICIOUS.test(name) && !isClaudeSignInVariable(name) && !REVIEWED.includes(name)).sort()
    expect(unreviewed, 'classify these: drop them in isClaudeSignInVariable, or add them to fixtures/claudeEnvReviewed.json').toEqual([])
  }, 60_000)
})

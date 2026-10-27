/**
 * PR 6 §2: the environment of a locked bot process, built from nothing. Each platform keeps its
 * allowlist and the proxy and certificate settings; POSIX gets `TMPDIR` in the scratch folder. An
 * ambient Pi instance gets exactly its provider's cloud credentials (fact 32) and nothing else under
 * those prefixes; key, subscription and Claude instances get none. The driver's home, the
 * instance's secret and the enforced values follow, in that order.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lockedEnv, type LockedEnvInput } from '../../src/mms/harness/env'
import { PI_AMBIENT_ENV } from '../../src/mms/harness/pi/envKeys'

const repoRoot = resolve(__dirname, '..', '..')

const AWS = PI_AMBIENT_ENV['amazon-bedrock']
const GOOGLE = PI_AMBIENT_ENV['google-vertex']

/** Every ambient variable set, plus the ones that must never be copied. */
const cloud: NodeJS.ProcessEnv = {
  ...Object.fromEntries([...AWS, ...GOOGLE].map((name) => [name, `v-${name}`])),
  AWS_MAX_ATTEMPTS: '5',
  AWS_RETRY_MODE: 'adaptive',
  AWS_DEFAULTS_MODE: 'cross-region',
  AWS_BEDROCK_SKIP_AUTH: '1',
  AWS_BEDROCK_FORCE_CACHE: '1',
  GCE_METADATA_HOST: '169.254.169.254',
  GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '1',
  GOOGLE_CLOUD_API_KEY: 'vertex-key',
  AWS_FOO: 'unknown',
  CLOUDSDK_CORE_PROJECT: 'p'
}

const posixBase: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/me',
  USER: 'me',
  LOGNAME: 'me',
  SHELL: '/bin/zsh',
  LANG: 'en_GB.UTF-8',
  LC_ALL: 'en_GB.UTF-8',
  LC_CTYPE: 'UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/var/folders/x',
  http_proxy: 'http://proxy:3128',
  HTTPS_PROXY: 'http://proxy:3128',
  no_proxy: 'localhost',
  NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
  SSL_CERT_FILE: '/etc/ssl.pem',
  // Never copied.
  ANTHROPIC_API_KEY: 'sk-ant-parent',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  OPENROUTER_API_KEY: 'or-parent',
  NODE_OPTIONS: '--inspect',
  ELECTRON_RUN_AS_NODE: '1',
  MOUSSE_PROFILE: 'p',
  SSH_AUTH_SOCK: '/tmp/agent',
  GITHUB_TOKEN: 'ghp',
  Path: 'not-posix',
  ...cloud
}

const windowsBase: NodeJS.ProcessEnv = {
  Path: 'C:\\Windows;C:\\Tools',
  PATHEXT: '.COM;.EXE',
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\cmd.exe',
  USERPROFILE: 'C:\\Users\\me',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
  CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
  HTTPS_PROXY: 'http://proxy:3128',
  NODE_EXTRA_CA_CERTS: 'C:\\ca.pem',
  // Never copied.
  HOME: 'C:\\Users\\me',
  SHELL: 'bash',
  USERNAME: 'me',
  ANTHROPIC_API_KEY: 'sk-ant-parent',
  OPENROUTER_API_KEY: 'or-parent',
  ...cloud
}

const POSIX_KEPT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'http_proxy', 'HTTPS_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
const WINDOWS_KEPT = ['Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramData', 'ProgramFiles', 'CLAUDE_CODE_GIT_BASH_PATH', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']

function env(input: Partial<LockedEnvInput> = {}): NodeJS.ProcessEnv {
  return lockedEnv({ platform: 'linux', base: posixBase, driver: 'pi', provider: 'openrouter', credential: 'api_key', scratch: '/profile/bots/scratch/act-1', ...input })
}

const sorted = (names: Iterable<string>) => [...names].sort()

describe('lockedEnv per platform', () => {
  it('POSIX: the allowlist, the network settings in any case, and TMPDIR in the scratch folder', () => {
    const result = env()
    expect(sorted(Object.keys(result))).toEqual(sorted([...POSIX_KEPT, 'TMPDIR']))
    for (const name of POSIX_KEPT) expect(result[name], name).toBe(posixBase[name])
    expect(result.TMPDIR).toBe('/profile/bots/scratch/act-1/tmp')
  })

  it.each(['darwin', 'linux'] as const)('%s: the same', (platform) => {
    expect(sorted(Object.keys(env({ platform })))).toEqual(sorted([...POSIX_KEPT, 'TMPDIR']))
  })

  it('Windows: its own allowlist, in the parent\'s spelling, and no TMPDIR', () => {
    const result = env({ platform: 'win32', base: windowsBase, scratch: 'C:\\profile\\bots\\scratch\\act-1' })
    expect(sorted(Object.keys(result))).toEqual(sorted(WINDOWS_KEPT))
    for (const name of WINDOWS_KEPT) expect(result[name], name).toBe(windowsBase[name])
  })
})

describe('lockedEnv credentials', () => {
  it('an ambient amazon-bedrock instance gets exactly the AWS set', () => {
    const result = env({ provider: 'amazon-bedrock', credential: 'ambient' })
    expect(sorted(Object.keys(result).filter((name) => !POSIX_KEPT.includes(name) && name !== 'TMPDIR'))).toEqual(sorted(AWS))
    for (const name of AWS) expect(result[name]).toBe(`v-${name}`)
  })

  it('an ambient google-vertex instance gets exactly the Google set, never Vertex\'s API key', () => {
    const result = env({ provider: 'google-vertex', credential: 'ambient' })
    expect(sorted(Object.keys(result).filter((name) => !POSIX_KEPT.includes(name) && name !== 'TMPDIR'))).toEqual(sorted(GOOGLE))
    expect(result).not.toHaveProperty('GOOGLE_CLOUD_API_KEY')
  })

  it('the same on Windows, whatever the case', () => {
    const base = { ...windowsBase, aws_profile: undefined, Aws_Region: 'eu-west-1' }
    delete base.AWS_REGION
    const result = env({ platform: 'win32', base, provider: 'amazon-bedrock', credential: 'ambient', scratch: 'C:\\s' })
    expect(result.Aws_Region).toBe('eu-west-1')
    expect(result.AWS_PROFILE).toBe('v-AWS_PROFILE')
    expect(result).not.toHaveProperty('AWS_MAX_ATTEMPTS')
  })

  it.each([
    ['a key-based Pi instance', { provider: 'amazon-bedrock', credential: 'api_key' as const }],
    ['a subscription Pi instance', { provider: 'google-vertex', credential: 'subscription' as const }],
    ['an unknown Pi instance', { provider: 'amazon-bedrock', credential: 'unknown' as const }],
    ['an ambient Pi instance of another provider', { provider: 'openrouter', credential: 'ambient' as const }],
    ['a Claude instance', { driver: 'claude' as const, provider: 'amazon-bedrock', credential: 'ambient' as const }]
  ])('%s gets no cloud credentials', (_name, input) => {
    const result = env(input)
    expect(Object.keys(result).filter((name) => /^(AWS|GOOGLE|GCLOUD|CLOUDSDK|GCE)_/i.test(name))).toEqual([])
  })

  it('never copies the retry, defaults, test, metadata or unknown variables', () => {
    const result = env({ provider: 'amazon-bedrock', credential: 'ambient' })
    for (const name of ['AWS_MAX_ATTEMPTS', 'AWS_RETRY_MODE', 'AWS_DEFAULTS_MODE', 'AWS_BEDROCK_SKIP_AUTH', 'AWS_BEDROCK_FORCE_CACHE', 'GCE_METADATA_HOST', 'GOOGLE_CLOUD_API_KEY', 'AWS_FOO'])
      expect(result, name).not.toHaveProperty(name)
    const vertex = env({ provider: 'google-vertex', credential: 'ambient' })
    for (const name of ['GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES', 'CLOUDSDK_CORE_PROJECT', 'GOOGLE_CLOUD_API_KEY', 'GCE_METADATA_HOST']) expect(vertex, name).not.toHaveProperty(name)
  })

  it('sets the home, then the instance secret, then the enforced values last', () => {
    const result = env({
      driver: 'claude',
      credential: 'api_key',
      home: '/profile/harness/claude_bot/home',
      secrets: { ANTHROPIC_API_KEY: 'sk-ant-instance', CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      enforced: { CLAUDE_CODE_ENABLE_TELEMETRY: '0', DISABLE_TELEMETRY: '1', HOME: '/enforced' }
    })
    expect(result.CLAUDE_CONFIG_DIR).toBe('/profile/harness/claude_bot/home')
    expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-instance')
    expect(result.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('0')
    expect(result.DISABLE_TELEMETRY).toBe('1')
    expect(result.HOME).toBe('/enforced')
    expect(result).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('a later value replaces any other spelling of the name on Windows', () => {
    const result = env({ platform: 'win32', base: { ...windowsBase, https_proxy: 'lower' }, secrets: { https_PROXY: 'x' }, enforced: { HTTPS_PROXY: 'enforced' }, scratch: 'C:\\s' })
    expect(Object.keys(result).filter((name) => name.toUpperCase() === 'HTTPS_PROXY')).toEqual(['HTTPS_PROXY'])
    expect(result.HTTPS_PROXY).toBe('enforced')
  })
})

/**
 * Variables the pinned bundle reads under the cloud prefixes that are deliberately not copied. A
 * newly read variable fails the diff below until it is either added to `PI_AMBIENT_ENV` or listed
 * here with its reason.
 */
const NOT_COPIED: Record<string, string> = {
  // Retries and defaults: the launcher pins one attempt per request.
  AWS_MAX_ATTEMPTS: 'retry', AWS_RETRY_MODE: 'retry', AWS_DEFAULTS_MODE: 'retry',
  // Test switches of pi-ai's Bedrock stream.
  AWS_BEDROCK_SKIP_AUTH: 'test', AWS_BEDROCK_FORCE_CACHE: 'test', AWS_BEDROCK_FORCE_HTTP1: 'test',
  // Instance metadata services.
  GCE_METADATA_HOST: 'metadata', GCE_METADATA_IP: 'metadata', AWS_EC2_METADATA_DISABLED: 'metadata', AWS_EC2_METADATA_SERVICE_ENDPOINT: 'metadata',
  AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: 'metadata', AWS_EC2_METADATA_V1_DISABLED: 'metadata',
  // Google external-account (workload identity) executables and flows.
  GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: 'external account', GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE: 'external account', GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL: 'external account',
  GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE: 'external account', GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE: 'external account', GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE: 'external account',
  // Keys: credentials, not ambient config (Vertex's API key; the Gemini SDK's key).
  GOOGLE_CLOUD_API_KEY: 'credential', GOOGLE_API_KEY: 'credential',
  // SDK host detection, optional credential metadata, endpoint and logging switches.
  AWS_EXECUTION_ENV: 'sdk', AWS_LAMBDA_BENCHMARK_MODE: 'sdk', AWS_LAMBDA_FUNCTION_NAME: 'sdk', AWS_LAMBDA_MAX_CONCURRENCY: 'sdk', AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED: 'sdk',
  AWS_SDK_JS_TYPESCRIPT_DETECTION_DISABLED: 'sdk', AWS_SDK_UA_APP_ID: 'sdk', AWS_AUTH_SCHEME_PREFERENCE: 'sdk', AWS_SIGV4A_SIGNING_REGION_SET: 'sdk', AWS_ACCOUNT_ID: 'sdk',
  AWS_CREDENTIAL_SCOPE: 'sdk', GOOGLE_SDK_NODE_LOGGING: 'sdk', GOOGLE_API_CERTIFICATE_CONFIG: 'sdk', GOOGLE_GENAI_USE_ENTERPRISE: 'sdk', GOOGLE_GENAI_USE_VERTEXAI: 'sdk',
  GOOGLE_VERTEX_BASE_URL: 'sdk', GOOGLE_GEMINI_BASE_URL: 'sdk',
  // The prefix `AWS_BEARER_TOKEN_BEDROCK` is built from.
  AWS_BEARER_TOKEN_: 'prefix',
  // Enum values that look like variables (Bedrock guardrail PII types, Gemini tool and auth types).
  AWS_ACCESS_KEY: 'not a variable', AWS_SECRET_KEY: 'not a variable', GOOGLE_MAPS: 'not a variable', GOOGLE_SEARCH_IMAGE: 'not a variable',
  GOOGLE_SEARCH_WEB: 'not a variable', GOOGLE_SERVICE_ACCOUNT_AUTH: 'not a variable'
}

describe('the ambient sets against the pinned Pi bundle', () => {
  it('cover every cloud variable the bundle reads, apart from the listed exclusions', () => {
    const chunks = join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks')
    const read = new Set<string>()
    for (const name of readdirSync(chunks)) {
      const source = readFileSync(join(chunks, name), 'utf8')
      for (const match of source.matchAll(/(?:process\.env\.|env\.|["'`])((?:AWS|GOOGLE|GCLOUD|CLOUDSDK|GCE_METADATA)_[A-Z0-9_]*)/g)) read.add(match[1])
    }
    expect(read.size).toBeGreaterThan(30)
    for (const name of [...AWS, ...GOOGLE]) expect(Object.hasOwn(NOT_COPIED, name), name).toBe(false)
    expect(sorted(read)).toEqual(sorted([...AWS, ...GOOGLE, ...Object.keys(NOT_COPIED)]))
  })
})

import { describe, expect, it } from 'vitest'
import { explicitActionGitEnv, nonInteractiveGitEnv } from '../src/mms/git/gitEnv'
import { GIT_NULL_DEVICE } from '../src/mms/git/gitNullDevice'
import { redactGitText } from '../src/shared/gitText'

describe('redactGitText tokens and headers', () => {
  it.each([
    ['a fine-grained GitHub token', 'remote: token github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz_0123456789 was used', 'github_pat_'],
    ['a GitLab token on its own', 'using glpat-xxxxxxxxxxxxxxxxxxxx for the push', 'glpat-xxxx'],
    ['an Authorization header with any scheme', 'Authorization: token ghs_realsecretvalue', 'realsecretvalue'],
    ['a Proxy-Authorization header', 'Proxy-Authorization: Negotiate YIIabcdef123456', 'YIIabcdef'],
    ['an Authorization header in a trace', "> Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260101", 'AKIAEXAMPLE'],
    ['a JWT', 'id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'eyJzdWIi']
  ])('hides %s', (_name, text, secret) => {
    const out = redactGitText(text)
    expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })
})

describe('redactGitText', () => {
  it('removes credentials from http, ssh and git URLs and from user:password@host without a scheme', () => {
    expect(redactGitText('fatal: unable to access https://user:token@example.com/org/repo.git/')).toBe('fatal: unable to access https://[redacted]@example.com/org/repo.git/')
    expect(redactGitText('remote: ssh://git:hunter2@host.example:2222/repo.git')).toBe('remote: ssh://[redacted]@host.example:2222/repo.git')
    expect(redactGitText('cloning git://deploy:s3cret@host/repo.git')).toBe('cloning git://[redacted]@host/repo.git')
    expect(redactGitText('fetching admin:hunter2@git.example.com:org/repo.git')).toBe('fetching [redacted]@git.example.com:org/repo.git')
  })

  it('redacts credentials whatever the host looks like', () => {
    expect(redactGitText('fatal: user:secret-password@gitserver:repo.git')).toBe('fatal: [redacted]@gitserver:repo.git')
    expect(redactGitText('fatal: user:secret-password@10.0.0.5:repo.git')).toBe('fatal: [redacted]@10.0.0.5:repo.git')
    expect(redactGitText('fatal: user:secret-password@[::1]:repo.git')).toBe('fatal: [redacted]@[::1]:repo.git')
    expect(redactGitText('unable to access https://5up3rs3cr3t7oken@dev.azure.com/org/_git/repo/')).toBe('unable to access https://[redacted]@dev.azure.com/org/_git/repo/')
    expect(redactGitText('remote: ssh://git@host.example/repo.git')).toBe('remote: ssh://git@host.example/repo.git')
  })

  it('keeps ordinary Git text and scp-style addresses without a password', () => {
    for (const line of ['git@github.com:org/repo.git', 'To github.com:org/repo.git', ' ! [rejected]        main -> main (fetch first)', 'remote: Resolving deltas: 100% (3/3), done.']) {
      expect(redactGitText(line)).toBe(line)
    }
  })

  it('redacts bearer tokens and token query values through the shared redaction', () => {
    expect(redactGitText('Authorization failed: Bearer abc.def.ghi')).not.toContain('abc.def.ghi')
    expect(redactGitText('GET https://host/x?access_token=abcdef123')).toBe('GET https://host/x?access_token=[redacted]')
  })

  it('caps each line at 500 characters and keeps the line count', () => {
    const long = 'x'.repeat(2000)
    const lines = redactGitText(`first\n${long}\r\nlast`).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('first')
    expect(lines[1].length).toBeLessThanOrEqual(501)
    expect(lines[2]).toBe('last')
  })
})

describe('git environments', () => {
  it('an explicit action only turns off terminal prompts', () => {
    expect(explicitActionGitEnv()).toEqual({ GIT_TERMINAL_PROMPT: '0' })
  })

  it('the non-interactive set keeps the bridge values and leaves LFS settings to the bridge', () => {
    expect(nonInteractiveGitEnv()).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: GIT_NULL_DEVICE,
      SSH_ASKPASS: GIT_NULL_DEVICE,
      SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never'
    })
  })
})

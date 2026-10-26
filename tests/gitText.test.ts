import { describe, expect, it } from 'vitest'
import { explicitActionGitEnv, nonInteractiveGitEnv } from '../src/mms/git/gitEnv'
import { GIT_NULL_DEVICE } from '../src/mms/git/gitNullDevice'
import { redactGitText } from '../src/shared/gitText'

describe('redactGitText', () => {
  it('removes credentials from http, ssh and git URLs and from user:password@host without a scheme', () => {
    expect(redactGitText('fatal: unable to access https://user:token@example.com/org/repo.git/')).toBe('fatal: unable to access https://[redacted]@example.com/org/repo.git/')
    expect(redactGitText('remote: ssh://git:hunter2@host.example:2222/repo.git')).toBe('remote: ssh://[redacted]@host.example:2222/repo.git')
    expect(redactGitText('cloning git://deploy:s3cret@host/repo.git')).toBe('cloning git://[redacted]@host/repo.git')
    expect(redactGitText('fetching admin:hunter2@git.example.com:org/repo.git')).toBe('fetching [redacted]@git.example.com:org/repo.git')
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

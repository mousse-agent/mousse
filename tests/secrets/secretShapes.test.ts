import { expect, it } from 'vitest'
import { pastedSecretShape } from '../../src/shared/secretShapes'
const a = 'A'.repeat(48)
const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc==\n-----END PRIVATE KEY-----'
// Each row names the exact replaced span; surrounding prose is never part of a kept value.
const shapes: Array<[string, string, string]> = [
  [`sk-${a}`, `sk-${a}`, 'OPENAI_API_KEY'],
  [`sk-ant-${a}`, `sk-ant-${a}`, 'ANTHROPIC_API_KEY'], [`sk-or-${a}`, `sk-or-${a}`, 'OPENROUTER_API_KEY'],
  ...['sk_live_', 'rk_live_', 'sk_test_', 'rk_test_'].map(prefix => [prefix+a, prefix+a, 'STRIPE_SECRET_KEY'] as [string,string,string]),
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'].map(prefix => [prefix+a, prefix+a, 'GITHUB_TOKEN'] as [string,string,string]),
  ['AKIA1234567890123456', 'AKIA1234567890123456', 'AWS_ACCESS_KEY_ID'],
  ...['AKIA', 'ASIA'].flatMap(prefix => [' ', '\n', '\naws_secret_access_key=', ' aws_secret_access_key: '].map(separator => [prefix+'1234567890123456'+separator+aws, prefix+'1234567890123456'+separator+aws, 'AWS_SECRET_ACCESS_KEY'] as [string,string,string])),
  [`aws_secret_access_key = ${aws}`, `aws_secret_access_key = ${aws}`, 'AWS_SECRET_ACCESS_KEY'],
  ...['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'].map(prefix => [prefix+a, prefix+a, 'SLACK_TOKEN'] as [string,string,string]),
  ['AIza'+'A'.repeat(35), 'AIza'+'A'.repeat(35), 'GOOGLE_API_KEY'], ['ya29.'+a, 'ya29.'+a, 'GOOGLE_OAUTH_TOKEN'],
  ...Object.entries({ 'glpat-':'GITLAB_TOKEN','npm_':'NPM_TOKEN','hf_':'HUGGING_FACE_TOKEN','whsec_':'STRIPE_WEBHOOK_SECRET','gsk_':'GROQ_API_KEY','GOCSPX-':'GOOGLE_CLIENT_SECRET' }).map(([prefix,name]) => [prefix+a,prefix+a,name] as [string,string,string]),
  ['SG.'+'A'.repeat(22)+'.'+a,'SG.'+'A'.repeat(22)+'.'+a,'SENDGRID_API_KEY'],
  ['123456789:AA'+'A'.repeat(30),'123456789:AA'+'A'.repeat(30),'TELEGRAM_BOT_TOKEN'],
  ['Authorization: Bearer eyJabc.def.ghi','Bearer eyJabc.def.ghi','API_KEY'],
  ['https://hooks.slack.com/services/T123/B456/abc123','https://hooks.slack.com/services/T123/B456/abc123','SLACK_WEBHOOK_URL'],
  ['https://discord.com/api/webhooks/123456/abc123','https://discord.com/api/webhooks/123456/abc123','DISCORD_WEBHOOK_URL'],
  ['postgres://me:password@example.com/db','postgres://me:password@example.com/db','DATABASE_URL'],
  ['read https://example.com?api_key=abc please','https://example.com?api_key=abc','API_KEY'],
  ['https://me:password@example.com','https://me:password@example.com','API_KEY'],
  [pem+'\nThanks',pem,'PRIVATE_KEY'],
  ['-----BEGIN PRIVATE KEY-----\nMIIabc==\n\nThanks','-----BEGIN PRIVATE KEY-----\nMIIabc==','PRIVATE_KEY'],
  ['-----BEGIN PRIVATE KEY-----\nMIIabc==\nnow deploy please','-----BEGIN PRIVATE KEY-----\nMIIabc==','PRIVATE_KEY'],
  ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG\n\nYWJjZA==\n-----END PGP PRIVATE KEY BLOCK-----\nThanks','-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG\n\nYWJjZA==\n-----END PGP PRIVATE KEY BLOCK-----','PRIVATE_KEY'],
  [`OPENAI_KEY_sk-${a}`,`sk-${a}`,'OPENAI_API_KEY'],
  [`sk-${a} ghp_${a}`,`sk-${a}`,'OPENAI_API_KEY'],
  [`sk-${a} https://me:password@example.com`,`sk-${a}`,'OPENAI_API_KEY']
]
it.each(shapes)('selects the complete credential span and its service: %s', (text, span, name) => {
  const start = text.indexOf(span)
  expect(pastedSecretShape(text)).toEqual({ start, end: start+span.length, name })
})
it.each(['a'.repeat(64), '4fad019e-422c-4a1b-8f54-284951a51f37', 'a'.repeat(40), 'Please check the release', 'eyJabc.def.ghi', 'Bearer eyJabc.def.ghi', 'sk-learn-compatible-estimator', 'https://example.com/blog/sk-hynix-earnings-report-2026', ...['sort_key=price','pageToken=abc','favourite_monkey=bob','signature=short','sig=x'].map(query=>'https://example.com?'+query)])('does not offer for ordinary text: %s', text => expect(pastedSecretShape(text)).toBeUndefined())
it('checks a pathological 64 KB draft within 50 ms', () => {
  const text = 'a-'.repeat(32700)+'://example.com/?pageToken=abc'
  const start=performance.now()
  expect(pastedSecretShape(text)).toBeUndefined()
  expect(performance.now()-start).toBeLessThan(50)
})

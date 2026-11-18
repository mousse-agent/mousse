import { expect, it } from 'vitest'
import { pastedSecretShape, unmistakableCredential, pastedSecretValue, pastedSecretReplacement } from '../../src/shared/secretShapes'
const a = 'A'.repeat(48)
const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc==\n-----END PRIVATE KEY-----'
// Each row names the exact replaced span; surrounding prose is never part of a kept value.
const shapes: Array<[string, string, string]> = [
  [`sk-${a}`, `sk-${a}`, 'OPENAI_API_KEY'],
  [`sk-ant-${a}`, `sk-ant-${a}`, 'ANTHROPIC_API_KEY'], [`sk-or-${a}`, `sk-or-${a}`, 'OPENROUTER_API_KEY'],
  ...['sk_live_', 'rk_live_', 'sk_test_', 'rk_test_'].map(prefix => [prefix+a, prefix+a, 'STRIPE_SECRET_KEY'] as [string,string,string]),
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'].map(prefix => [prefix+a, prefix+a, 'GITHUB_TOKEN'] as [string,string,string]),
  
  ...['AKIA', 'ASIA'].flatMap(prefix => [' ', '\n', '\naws_secret_access_key=', ' aws_secret_access_key: '].map(separator => [prefix+'1234567890123456'+separator+aws, prefix+'1234567890123456'+separator+aws, 'AWS_SECRET_ACCESS_KEY'] as [string,string,string])),
  [`aws_secret_access_key = ${aws}`, `aws_secret_access_key = ${aws}`, 'AWS_SECRET_ACCESS_KEY'],
  ...['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'].map(prefix => [prefix+a, prefix+a, 'SLACK_TOKEN'] as [string,string,string]),
  ['AIza'+'A'.repeat(35), 'AIza'+'A'.repeat(35), 'GOOGLE_API_KEY'], ['ya29.'+a, 'ya29.'+a, 'GOOGLE_OAUTH_TOKEN'],
  ...Object.entries({ 'glpat-':'GITLAB_TOKEN','whsec_':'STRIPE_WEBHOOK_SECRET','gsk_':'GROQ_API_KEY','GOCSPX-':'GOOGLE_CLIENT_SECRET' }).map(([prefix,name]) => [prefix+a,prefix+a,name] as [string,string,string]),
  ['SG.'+'A'.repeat(22)+'.'+a,'SG.'+'A'.repeat(22)+'.'+a,'SENDGRID_API_KEY'],
  ['123456789:AA'+'A'.repeat(30),'123456789:AA'+'A'.repeat(30),'TELEGRAM_BOT_TOKEN'],
  ['npm_'+'A'.repeat(36),'npm_'+'A'.repeat(36),'NPM_TOKEN'],
  ['hf_'+a,'hf_'+a,'HUGGING_FACE_TOKEN'],
  ['Authorization: Bearer eyJabc.def.ghi','Authorization: Bearer eyJabc.def.ghi','API_KEY'],
  ['https://hooks.slack.com/services/T123/B456/abc123','https://hooks.slack.com/services/T123/B456/abc123','SLACK_WEBHOOK_URL'],
  ['https://discord.com/api/webhooks/123456/abc123','https://discord.com/api/webhooks/123456/abc123','DISCORD_WEBHOOK_URL'],
  ['postgres://me:password@example.com/db','postgres://me:password@example.com/db','DATABASE_URL'],
  ['read https://example.com?api_key=aB3dE5fG7hI9jK1mN2pQ4rS6tU8vW0xY please','https://example.com?api_key=aB3dE5fG7hI9jK1mN2pQ4rS6tU8vW0xY','API_KEY'],
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
it.each([
  'a-'.repeat(32700)+'://example.com/?pageToken=abc',
  'https://example.com/'+'.'.repeat(65000)+'x'
])('checks a pathological 64 KB draft with a generous latency budget', text => {
  const start=performance.now()
  expect(pastedSecretShape(text)).toBeUndefined()
  expect(performance.now()-start).toBeLessThan(1000)
})

it('keeps the adjacent secret even when it precedes the AWS ID on the same line',()=>{
  const text=aws+' AKIAIOSFODNN7EXAMPLE'
  expect(pastedSecretShape(text)).toEqual({start:0,end:text.length,name:'AWS_SECRET_ACCESS_KEY'})
})

// Master's action fence is deliberately broader than the composer offer.
it.each([
 ...['svcacct-','admin-','None-','proj-',''].map(prefix=>['sk-'+prefix+'Z'.repeat(30),true] as const),
 ['sk-'+'a'.repeat(16),true], ['sk-'+'a'.repeat(32),true],
 ...['private_token','refresh_token','sessionToken','pwd','passwd','access_key','secret_key','id_token','auth_token','authorization','credentials','X-Amz-Signature','X-Goog-Signature'].map(name=>['https://example.com?'+name+'=abc',true] as const),
 ['Authorization: Bearer eyJabc.def.ghi',false],['npm_config_global_prefix',false],['https://example.com?auth=login',false],['glpat-'+'A'.repeat(30),false]
])('preserves master action credential result for %s',(text,result)=>expect(unmistakableCredential(text)).toBe(result))
const id='AKIAIOSFODNN7EXAMPLE'
const awsFormats=[
 `Access key ID,Secret access key\n${id},${aws}`,
 `{"AccessKeyId":"${id}","SecretAccessKey":"${aws}"}`,
 `AWS_ACCESS_KEY_ID="${id}"\nAWS_SECRET_ACCESS_KEY="${aws}"`,
 `AWS Access Key ID [None]: ${id}\nAWS Secret Access Key [None]: ${aws}`,
 `id is ${id} and secret is ${aws}`,
 `${aws}  \n  ${id}`,
 `aws_secret_access_key = ${aws}\n${id}`
]
it.each(awsFormats)('keeps AWS secret in its complete paste format: %s',text=>{
 const shape=pastedSecretShape(text)!
 expect(shape?.name).toBe('AWS_SECRET_ACCESS_KEY')
 expect(text.slice(shape.start,shape.end)).toContain(aws)
})
it.each([id,`commit ${'a'.repeat(40)} ${id}`,'npm_config_global_prefix','npm_package_devDependencies_typescript','hf_hub_download_and_cache_files','https://example.com?auth=login','https://example.com?password=forgot','https://www.google.com/maps/embed/v1/place?key=AIza'+'A'.repeat(35)])('does not offer a public ID or ordinary token-shaped text: %s',text=>expect(pastedSecretShape(text)).toBeUndefined())
it.each(['svcacct','admin'])('offers for OpenAI %s keys',prefix=>expect(pastedSecretShape('sk-'+prefix+'-'+'A'.repeat(48))?.name).toBe('OPENAI_API_KEY'))
it.each(['#access_token=','?X-Amz-Signature=','?X-Goog-Signature='])('keeps the whole signed or OAuth URL: %s',part=>{
 const text='https://example.com/path'+part+'aB3dE5fG7hI9jK1mN2pQ4rS6tU8vW0xY'
 expect(pastedSecretShape(text)).toEqual({start:0,end:text.length,name:'API_KEY'})
})

it('scales the long URL token walk across two sizes',()=>{
 const measure=(n:number)=>{const text='https://example.com/'+'.'.repeat(n)+'x';const start=performance.now();for(let i=0;i<5;i++) pastedSecretShape(text);return performance.now()-start}
 const small=measure(32000),large=measure(64000)
 expect(large).toBeLessThan(1000)
 expect(large).toBeLessThan(Math.max(small,1)*3)
})

it.each([
 `path ${'P'.repeat(40)} then ${id} ${aws}`,
 `older ${'B'.repeat(40)} ${'context '.repeat(8)}${id} secret is ${aws}`,
 ...['aws_secret_access_key','AWS_SECRET_ACCESS_KEY','SecretAccessKey'].map(label=>`older ${'B'.repeat(40)} ${id} ${'C'.repeat(40)} "${label}":"${aws}"`),
 `"SecretAccessKey":"${aws}" older ${'B'.repeat(40)} ${id}`
])('prefers the labelled AWS secret, otherwise the nearest token: %s',text=>{
 const shape=pastedSecretShape(text)!
 const span=text.slice(shape.start,shape.end)
 expect(pastedSecretValue(span)).toBe(aws)
 const replaced=text.slice(0,shape.start)+pastedSecretReplacement(span,'AWS_SECRET_ACCESS_KEY')+text.slice(shape.end)
 expect(replaced).toContain(id)
 expect(replaced).not.toContain(aws)
 if(text.includes('B'.repeat(40))) expect(replaced).toContain('B'.repeat(40))
})

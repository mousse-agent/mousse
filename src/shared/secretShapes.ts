// Deliberately narrower than the memory heuristic: bare IDs, JWTs and prose are not credentials.
export const UNMISTAKABLE_KEYS = /sk-(?:(?:ant|or|proj)-[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{48,})|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])|ya29\.[0-9A-Za-z_-]{20,}|(?:glpat-|npm_|hf_|whsec_|gsk_|GOCSPX-)[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/
export interface SecretShape { start: number; end: number; name: string }
const awsTail = /^(?:[ \t]+|\r?\n[ \t]*)(?:aws_secret_access_key[ \t]*[=:][ \t]*)?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/i
const awsLabel = /aws_secret_access_key[ \t]*[=:][ \t]*[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi
const awsHead = /(?<![A-Za-z0-9/+])(?:aws_secret_access_key[ \t]*[=:][ \t]*)?([A-Za-z0-9/+]{40})(?:[ \t]+|\r?\n[ \t]*)$/i

function keyName(key: string): string {
  if (key.startsWith('sk-ant-')) return 'ANTHROPIC_API_KEY'
  if (key.startsWith('sk-or-')) return 'OPENROUTER_API_KEY'
  if (key.startsWith('sk-')) return 'OPENAI_API_KEY'
  if (/^(?:sk|rk)_/.test(key)) return 'STRIPE_SECRET_KEY'
  if (/^(?:gh[pousr]_|github_pat_)/.test(key)) return 'GITHUB_TOKEN'
  if (/^(?:AKIA|ASIA)/.test(key)) return 'AWS_ACCESS_KEY_ID'
  if (key.startsWith('xox')) return 'SLACK_TOKEN'
  if (key.startsWith('AIza')) return 'GOOGLE_API_KEY'
  const names: Record<string,string> = { 'ya29.':'GOOGLE_OAUTH_TOKEN','glpat-':'GITLAB_TOKEN','npm_':'NPM_TOKEN','hf_':'HUGGING_FACE_TOKEN','whsec_':'STRIPE_WEBHOOK_SECRET','gsk_':'GROQ_API_KEY','GOCSPX-':'GOOGLE_CLIENT_SECRET','SG.':'SENDGRID_API_KEY' }
  for (const [prefix,name] of Object.entries(names)) if (key.startsWith(prefix)) return name
  return /^[0-9]/.test(key) ? 'TELEGRAM_BOT_TOKEN' : key.startsWith('-----BEGIN') ? 'PRIVATE_KEY' : 'API_KEY'
}

/** With no END, consume only key/header lines; preserve the following prose. */
function pemEnd(text: string, start: number, header: string): number {
  const close = text.indexOf(header.replace('BEGIN','END'), start+header.length)
  if (close >= 0) return close+header.length-2 // END is two characters shorter than BEGIN.
  let end=start+header.length
  let cursor=end
  while (cursor < text.length) {
    const newline = /^(?:\r?\n)/.exec(text.slice(cursor, cursor+2))
    if (!newline) break
    const lineStart=cursor+newline[0].length
    const next=text.indexOf('\n',lineStart)
    const lineEnd=next<0?text.length:next
    const line=text.slice(lineStart,lineEnd).replace(/\r$/, '')
    if (!line || !/^(?:[A-Za-z0-9+/=]+|[A-Za-z-]+: [^\r\n]+|-----[A-Z ]+-----)$/.test(line)) break
    end=lineStart+line.length;cursor=lineEnd
  }
  return end
}

function urlName(raw: string): string | undefined {
  try {
    const url=new URL(raw)
    if (url.protocol==='https:' && url.hostname==='hooks.slack.com' && /^\/services\/[^/]+\/[^/]+\/[^/]+/.test(url.pathname)) return 'SLACK_WEBHOOK_URL'
    if (url.protocol==='https:' && /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) && /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+/.test(url.pathname)) return 'DISCORD_WEBHOOK_URL'
    if (url.password) return /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|mssql):$/.test(url.protocol)?'DATABASE_URL':'API_KEY'
    for (const [key,value] of url.searchParams) {
      if (value && (/^(?:api_key|apikey|access_token|token|key|secret|password|auth|client_secret)$/i.test(key) || /^(?:sig|signature)$/i.test(key) && value.length>=20)) return 'API_KEY'
    }
  } catch { /* Invalid URLs are left for the owner to judge. */ }
  return undefined
}

/** Scan each token once. No scheme regex retries from every boundary in a long punctuation run. */
export function pastedSecretShape(text: string): SecretShape | undefined {
  let first: SecretShape | undefined
  const choose=(start:number,end:number,name:string) => { if (!first || start<first.start) first={start,end,name} }
  const match=UNMISTAKABLE_KEYS.exec(text)
  if (match) {
    const start=match.index, key=match[0]
    const pair=/^(?:AKIA|ASIA)/.test(key)?awsTail.exec(text.slice(start+key.length)):null
    const headStart=Math.max(0,start-512)
    const preceding=/^(?:AKIA|ASIA)/.test(key)?awsHead.exec(text.slice(headStart,start)):null
    choose(preceding?headStart+preceding.index:start, pair ? start+key.length+pair[0].length : key.startsWith('-----BEGIN') ? pemEnd(text,start,key) : start+key.length, pair||preceding?'AWS_SECRET_ACCESS_KEY':keyName(key))
  }
  awsLabel.lastIndex=0
  const labelled=awsLabel.exec(text)
  if (labelled) choose(labelled.index,labelled.index+labelled[0].length,'AWS_SECRET_ACCESS_KEY')
  const bearer=/\bauthorization[ \t]*:[ \t]*(Bearer[ \t]+eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.exec(text)
  if (bearer) choose(bearer.index,bearer.index+bearer[0].length,'API_KEY')
  if (text.includes('://')) {
    for (const token of text.matchAll(/[^\s<>"'`]+/g)) {
      const separator=token[0].indexOf('://')
      if (separator<0) continue
      let offset=separator
      while (offset>0 && /[A-Za-z0-9+.-]/.test(token[0][offset-1])) offset--
      let end=token[0].length
      while(end>offset && '),.;]'.includes(token[0][end-1])) end--
      const raw=token[0].slice(offset,end)
      const name=urlName(raw)
      if (name) choose(token.index!+offset,token.index!+offset+raw.length,name)
    }
  }
  return first
}

export function unmistakableCredential(text: string): boolean { return pastedSecretShape(text)!==undefined }

/** The pair's ID is public; only its secret half is kept. Labelled pastes have the same representation. */
export function pastedSecretValue(text: string): string {
  const bearer=/^authorization[ \t]*:[ \t]*Bearer[ \t]+(eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(text)
  if (bearer) return bearer[1]
  const id=/^(?:AKIA|ASIA)[0-9A-Z]{16}/.exec(text)
  if (id) return awsTail.exec(text.slice(id[0].length))?.[1] ?? text
  const reverse=/^([A-Za-z0-9/+]{40})(?:[ \t]+|\r?\n[ \t]*)(?:AKIA|ASIA)[0-9A-Z]{16}$/.exec(text)
  if (reverse) return reverse[1]
  return /^aws_secret_access_key[ \t]*[=:][ \t]*([A-Za-z0-9/+]{40})$/i.exec(text)?.[1] ?? text
}
export function pastedSecretReplacement(text: string, name: string): string {
  const id=/(?:AKIA|ASIA)[0-9A-Z]{16}/.exec(text)
  return `${id && pastedSecretValue(text)!==text ? id[0]+' ' : ''}the secret ${name}`
}

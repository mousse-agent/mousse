// Deliberately narrower than the memory heuristic: bare IDs, JWTs and prose are not credentials.
const PASTED_KEYS = /sk-(?:(?:ant|or|proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{48,})|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])|ya29\.[0-9A-Za-z_-]{20,}|(?:glpat-|whsec_|gsk_|GOCSPX-)[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])|hf_[A-Za-z0-9]{34,}(?![A-Za-z0-9_])|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/
export interface SecretShape { start: number; end: number; name: string }
const awsId = /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/
interface AwsSecretToken { 0: string; index: number; labelStart?: number }
function awsSecret(text:string):AwsSecretToken|null {
  const id=awsId.exec(text)
  const distance=(token:AwsSecretToken)=>id?Math.max(id.index-token.index-token[0].length,token.index-id.index-id[0].length,0):token.index
  const closest=(tokens:Iterable<AwsSecretToken>):AwsSecretToken|null=>{
    let found:AwsSecretToken|null=null
    for(const token of tokens) {
      if(/^[a-f0-9]{40}$/.test(token[0])) continue
      if(!found || distance(token)<distance(found)) found=token
    }
    return found
  }
  // Keep the label in a selected pair span so the daemon makes the same choice on revalidation.
  const labelled=Array.from(text.matchAll(/\b(?:aws_secret_access_key|SecretAccessKey)["']?\s*[=:]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi),match=>({0:match[1],index:match.index!+match[0].lastIndexOf(match[1]),labelStart:match.index!}))
  return closest(labelled) ?? closest(text.matchAll(/(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g))
}
export function missingAwsSecret(text:string):boolean {
 return awsId.test(text) && !awsSecret(text) && !/the secret AWS_SECRET_ACCESS_KEY/.test(text)
}

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
    if (/^(?:www\.)?google\.[a-z.]+$/.test(url.hostname) && url.pathname.startsWith('/maps/embed')) return undefined
    for (const [key,value] of [...url.searchParams,...new URLSearchParams(url.hash.slice(1))]) {
      const credential=value.length>=24 && new Set(value).size>=10
      if (credential && /^(?:api_key|apikey|access_token|refresh_token|private_token|access_key|secret_key|token|key|secret|password|auth|client_secret|sig|signature|X-Amz-Signature|X-Goog-Signature)$/i.test(key)) return 'API_KEY'
    }
  } catch { /* Invalid URLs are left for the owner to judge. */ }
  return undefined
}

/** Scan each token once. No scheme regex retries from every boundary in a long punctuation run. */
export function pastedSecretShape(text: string): SecretShape | undefined {
  let first: SecretShape | undefined
  const choose=(start:number,end:number,name:string) => { if (!first || start<first.start) first={start,end,name} }
  // A Maps embed API key is intentionally public; do not pick its AIza substring either.
  const scanned=text.replace(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps\/embed[^\s<>"'`]*/g,raw=>' '.repeat(raw.length))
  const match=PASTED_KEYS.exec(scanned)
  if (match) {
    const start=match.index,key=match[0]
    choose(start,key.startsWith('-----BEGIN')?pemEnd(text,start,key):start+key.length,keyName(key))
  }
  const id=awsId.exec(text),secret=awsSecret(text)
  if(id && secret) choose(Math.min(id.index,secret.labelStart??secret.index),Math.max(id.index+id[0].length,secret.index+secret[0].length),'AWS_SECRET_ACCESS_KEY')
  const labelled=/aws_secret_access_key[ \t]*[=:][ \t]*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])["']?/i.exec(text)
  if(!id && labelled && !/^[a-f0-9]{40}$/.test(labelled[1])) choose(labelled.index,labelled.index+labelled[0].length,'AWS_SECRET_ACCESS_KEY')
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

// Deliberately narrower than the memory heuristic: IDs, attachments and prose need review, not refusal.
const ACTION_UNMISTAKABLE_KEYS = /\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}\b|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}\b|ya29\.[0-9A-Za-z_-]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/
export function unmistakableCredential(text: string): boolean {
  if (ACTION_UNMISTAKABLE_KEYS.test(text)) return true
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
    try {
      const url = new URL(match[0])
      if (url.password || [...url.searchParams].some(([key, value]) => value && /(?:token|key|secret|signature|password|passwd|pwd|authorization|credentials?)$/i.test(key))) return true
    } catch { /* Invalid addresses remain visible to the owner. */ }
  }
  return false
}


/** The pair's ID is public; only its secret half is kept. Labelled pastes have the same representation. */
export function pastedSecretValue(text: string): string {
  const bearer=/^authorization[ \t]*:[ \t]*Bearer[ \t]+(eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(text)
  if (bearer) return bearer[1]
  if(awsId.test(text) || /^aws_secret_access_key/i.test(text)) return awsSecret(text)?.[0]??text
  return text
}
export function pastedSecretReplacement(text: string, name: string): string {
  const value=pastedSecretValue(text)
  return value!==text && awsSecret(text)?.[0]===value ? text.replace(value,`the secret ${name}`) : `the secret ${name}`
}

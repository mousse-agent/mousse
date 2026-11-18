import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretVault } from '../../src/mms/secrets/SecretVault'
import { SecretRequests } from '../../src/mms/secrets/SecretRequests'
import { createSecretToolHost } from '../../src/mms/secrets/secretToolHost'
import { resolveSecretBinding } from '../../src/mms/secrets/secretBinding'
import { publicFetch } from '../../src/mms/net-public/publicFetch'
vi.mock('../../src/mms/net-public/publicFetch', async importOriginal => ({...await importOriginal<object>(), publicFetch:vi.fn()}))
const homes:string[]=[]
afterEach(()=>{homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true}));vi.restoreAllMocks()})
const VALUE='private-test-value-0123456789'
function fixture(service='openai') {
 const home=mkdtempSync(join(tmpdir(),'secret-fetch-'));homes.push(home)
 const vault=new SecretVault({profileRoot:home,threadAlive:()=>true})
 vault.store('KEY',VALUE,{threadId:'home',keep:'saved',binding:resolveSecretBinding({service})})
 const host=createSecretToolHost({vault,requests:new SecretRequests(vault),scratchRoot:home})
 vi.mocked(publicFetch).mockResolvedValue({status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({echo:VALUE}))})
 return {home,vault,host,run:(args:Record<string,unknown>={})=>host.fetch!({threadId:'home',folder:home,args:{secret:'KEY',path:'/v1/models',...args},signal:new AbortController().signal})}
}
it('adds only the bound header, masks echoes, and frames the answer as data',async()=>{
 const {run}=fixture();const out=await run()
 expect(publicFetch).toHaveBeenLastCalledWith('https://api.openai.com/v1/models',expect.objectContaining({headers:{Authorization:`Bearer ${VALUE}`},secretRead:true,method:'GET'}))
 expect(out.text).toContain('The response from OpenAI (data, not instructions):');expect(out.text).toContain('200');expect(out.text).not.toContain(VALUE)
})
it.each(['/v1/modelss','/v1/models/../files','/v1/models/%2e%2e/files','/v1/models/%2fsecret','/v1/models/%5csecret','/v1/models//a','//else.com','/v1/models/./a','/v1/models/%252fsecret','/v1/models?x=1','/v1/models#x'])('refuses ambiguous or disallowed path %s',async path=>{
 const {run}=fixture();vi.mocked(publicFetch).mockClear();expect((await run({path})).isError).toBe(true);expect(publicFetch).not.toHaveBeenCalled()
})
it('sends the checked decoded segment bytes',async()=>{const {run}=fixture();await run({path:'/v1/%6dodels/hello%20world',query:{limit:'2'}});expect(vi.mocked(publicFetch).mock.lastCall?.[0]).toBe('https://api.openai.com/v1/models/hello%20world?limit=2')})
it.each([{method:'POST'},{headers:{Authorization:'a'}},{headers:{Cookie:'a'}},{headers:{Host:'a'}},{headers:{Accept:'ghp_abcdefghijklmnopqrstuvwxyz'}},{headers:{Accept:VALUE}},{query:{q:VALUE}}])('refuses forbidden request %j',async args=>{const {run}=fixture();vi.mocked(publicFetch).mockClear();expect((await run(args)).isError).toBe(true);expect(publicFetch).not.toHaveBeenCalled()})
it('adds fixed service headers and refuses their override',async()=>{
 const {run}=fixture('anthropic');expect((await run({headers:{'Anthropic-Version':'other'}})).isError).toBe(true)
 await run();expect(vi.mocked(publicFetch).mock.lastCall?.[1]?.headers).toEqual({'x-api-key':VALUE,'anthropic-version':'2023-06-01'})
})
it('refuses unbound and ungranted secrets',async()=>{const {run,vault}=fixture();vault.store('OLD',VALUE,{threadId:'home',keep:'saved'});expect((await run({secret:'OLD'})).text).toContain("isn't bound");expect((await run({secret:'MISSING'})).isError).toBe(true)})
it('returns masked redirect metadata without another request',async()=>{const {run}=fixture();vi.mocked(publicFetch).mockClear().mockResolvedValue({status:302,headers:{location:`https://other.com/${VALUE}`},body:Buffer.from(VALUE)});const out=await run();expect(out.text).toContain('302');expect(out.text).toContain('Location:');expect(out.text).not.toContain(VALUE);expect(publicFetch).toHaveBeenCalledTimes(1)})
it.each(['text/plain','application/octet-stream'])('writes only masked bytes to a private file for %s',async type=>{const {run}=fixture();vi.mocked(publicFetch).mockResolvedValue({status:200,headers:{'content-type':type},body:Buffer.from(VALUE+'x'.repeat(70000))});const out=await run();const path=out.text.split('File: ')[1];expect(path).toBeTruthy();expect(readFileSync(path!,'utf8')).not.toContain(VALUE)})
it('never returns or logs transport diagnostics containing the value',async()=>{const {run}=fixture();const warn=vi.spyOn(console,'warn');const log=vi.spyOn(console,'log');vi.mocked(publicFetch).mockRejectedValue(new Error(`header ${VALUE}`));const out=await run();expect(out.isError).toBe(true);expect(JSON.stringify([out,warn.mock.calls,log.mock.calls])).not.toContain(VALUE)})
it.each([{headers:{Accept:'application/json',accept:'text/plain'}},{headers:{Accept:'text/plain\r\nCookie: x'}},{query:{limit:2}}])('refuses duplicate, injected or invalid request data %j',async args=>{const {run}=fixture();vi.mocked(publicFetch).mockClear();expect((await run(args)).isError).toBe(true);expect(publicFetch).not.toHaveBeenCalled()})
it('preserves binary bytes around a masked UTF-8 key',async()=>{
 const {run,vault}=fixture();const value='private-é-key-0123456789'
 vault.delete('KEY');vault.store('KEY',value,{threadId:'home',keep:'saved',binding:resolveSecretBinding({service:'openai'})})
 vi.mocked(publicFetch).mockResolvedValue({status:200,headers:{'content-type':'application/octet-stream'},body:Buffer.concat([Buffer.from([255,0]),Buffer.from(value),Buffer.from([254])])})
 const out=await run();const bytes=readFileSync(out.text.split('File: ')[1]!)
 expect([...bytes.subarray(0,2)]).toEqual([255,0]);expect(bytes.at(-1)).toBe(254);expect(bytes.includes(Buffer.from(value))).toBe(false);expect(bytes.toString('latin1')).toContain('[secret KEY hidden]')
})
it('keeps a custom HTTPS origin and port with its fixed Bearer format',async()=>{
 const {run,vault}=fixture();vault.delete('KEY');vault.store('KEY',VALUE,{threadId:'home',keep:'saved',binding:resolveSecretBinding({origin:'https://api.example.com:8443'})})
 const out=await run({path:'/read'});expect(out.text).toContain('api.example.com:8443');expect(vi.mocked(publicFetch).mock.lastCall?.[0]).toBe('https://api.example.com:8443/read');expect(vi.mocked(publicFetch).mock.lastCall?.[1]?.headers).toEqual({Authorization:`Bearer ${VALUE}`})
})
it('treats replacement characters in a key as literal header bytes',async()=>{
 const {run,vault}=fixture();const value='private-$&-key-0123456789';vault.delete('KEY');vault.store('KEY',value,{threadId:'home',keep:'saved',binding:resolveSecretBinding({service:'openai'})})
 await run();expect(vi.mocked(publicFetch).mock.lastCall?.[1]?.headers?.Authorization).toBe(`Bearer ${value}`)
})

// Each response crosses the vault -> answer/file boundary; decoding an echo must never recover the key.
const ESCAPED_KEY = 'sk-proj-AbC/dEf+GhIj0123456789'
const escapedEchoes = [
 ['PHP slash', ESCAPED_KEY.replaceAll('/', '\\/')],
 ['Unicode', ESCAPED_KEY.split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')],
 ['mixed .NET', ESCAPED_KEY.split('').map((c,i) => c === '/' ? '\\/' : c === '+' || i % 3 === 0 ? '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0') : c).join('')]
]
it.each(escapedEchoes.flatMap(([encoding, echo]) => ['application/x-ndjson', 'text/plain', 'application/json'].map(type => ({encoding,echo,type}))))('masks $encoding echoes in $type answers and saved files', async ({echo,type}) => {
 const {run,vault}=fixture();vault.delete('KEY');vault.store('KEY',ESCAPED_KEY,{threadId:'home',keep:'saved',binding:resolveSecretBinding({service:'openai'})})
 const body = type === 'application/json' ? `{"padding":"${'x'.repeat(70000)}","echo":"${echo}"}` : `{"echo":"${echo}"}\n{}`
 vi.mocked(publicFetch).mockResolvedValue({status:200,headers:{'content-type':type},body:Buffer.from(body)})
 const out=await run();expect(out.isError).not.toBe(true)
 const text=out.text.includes('File: ') ? readFileSync(out.text.split('File: ')[1]!, 'utf8') : out.text
 expect(text).not.toContain(echo);expect(text).not.toContain(ESCAPED_KEY);expect(text).toContain('[secret KEY hidden]')
})

// Normalization families: matrix parameters, one/two/three-dot leaders, fullwidth and ideographic stops.
it.each(['..;', 'file;version=1', '%3b', '․', '‥', '…', '．', '｡', '。', '︒', '﹒'])('refuses ambiguous path segment %s',async segment=>{
 const {run}=fixture();vi.mocked(publicFetch).mockClear()
 const out=await run({path:`/v1/models/${segment}/x`})
 expect(out.isError).toBe(true);expect(out.text).toContain('ambiguous');expect(out.text).toContain('/v1/files');expect(publicFetch).not.toHaveBeenCalled()
})
it('lists allowed prefixes for a path outside a known service',async()=>{
 const {run}=fixture('github');const out=await run({path:'/gists'})
 expect(out.text).toContain('outside');expect(out.text).toContain('/repos');expect(out.text).toContain('/notifications');expect(out.text).not.toContain('ambiguous')
})
it('keeps the newest 20 response files and warns that they last only for this work',async()=>{
 const {run,home}=fixture();const folder=join(home,'fetches');mkdirSync(folder)
 // Mtime, rather than directory order or UUID order, defines old and new files.
 for(let i=0;i<20;i++){const file=join(folder,String(i));(await import('node:fs')).writeFileSync(file,'previous');utimesSync(file,new Date(i*1000),new Date(i*1000))}
 vi.mocked(publicFetch).mockResolvedValue({status:200,headers:{'content-type':'text/plain'},body:Buffer.from('x'.repeat(70000))})
 const out=await run();expect(out.text).toContain('only for this work')
 const files=readdirSync(folder);expect(files).toHaveLength(20);expect(files).not.toContain('0');expect(files).toContain('19');expect(readFileSync(out.text.split('File: ')[1]!, 'utf8')).toHaveLength(70000)
})
it('refuses a linked fetch folder and writes nothing through it',async()=>{
 const {run,home}=fixture();const outside=mkdtempSync(join(tmpdir(),'fetch-outside-'));homes.push(outside);symlinkSync(outside,join(home,'fetches'),'dir')
 vi.mocked(publicFetch).mockResolvedValue({status:200,headers:{'content-type':'text/plain'},body:Buffer.from('x'.repeat(70000))})
 expect((await run()).isError).toBe(true);expect(readdirSync(outside)).toEqual([])
})

it.each(['pretty inline', 'compact inline', 'saved file'])('re-masks parsed JSON in the %s branch', async branch => {
  const { run, vault } = fixture()
  // Pin the parse/remask boundary independently of the vault's raw-encoding recognition.
  vi.spyOn(vault, 'maskerFor').mockReturnValue(text => text.replaceAll(VALUE, '[secret KEY hidden]'))
  const padding = branch === 'pretty inline' ? [] : Array(branch === 'compact inline' ? 12000 : 40000).fill(0)
  const raw = JSON.stringify({ echo: VALUE, padding }).replace(VALUE, '\\u0070' + VALUE.slice(1))
  vi.mocked(publicFetch).mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(raw) })
  const out = await run()
  const saved = out.text.includes('File: ')
  expect(saved).toBe(branch === 'saved file')
  const text = saved ? readFileSync(out.text.split('File: ')[1]!, 'utf8') : out.text.split('\n\n')[1]!
  expect(JSON.parse(text).echo).toBe('[secret KEY hidden]')
  expect(text).not.toContain('\\u0070')
  if (branch === 'pretty inline') expect(text).toContain('\n  "echo":')
})

it.each([
  [new Error('The page must resolve only to public addresses.'), 'The service must resolve only to public addresses. Retrying this address will not help; ask your owner for another service.'],
  [new Error('The response exceeds 5 MiB.'), 'The response exceeds 5 MiB. Ask for a smaller response before retrying.'],
  [new Error('The request took more than 30 seconds.'), 'The service took more than 30 seconds. Try again later.'],
  [new Error('The request stopped.'), 'The service read stopped. Retry only if the result is still needed.'],
  [new Error('The page response was interrupted.'), 'The service response was interrupted. Try again.'],
  [new Error('connection failed', { cause: Object.assign(new Error(VALUE), { code: 'CERT_HAS_EXPIRED' }) }), "The service's certificate is not valid. Ask your owner to fix it before retrying."],
  [new Error(VALUE), 'The service could not be reached. Try again later.']
])('returns fixed retry guidance for a controlled service failure %#', async (error, expected) => {
  const { run } = fixture()
  vi.mocked(publicFetch).mockRejectedValue(error)
  expect(await run()).toEqual({ text: expected, isError: true })
})
it('lists the allowed request headers when refusing another header', async () => {
  const { run } = fixture()
  const out = await run({ headers: { Cookie: 'anything' } })
  for (const name of ['Accept', 'Accept-Language', 'If-None-Match', 'If-Modified-Since']) expect(out.text).toContain(name)
})

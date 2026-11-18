import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { publicFetch } from '../../src/mms/net-public/publicFetch'
it('connects to the trial resolver address once, preserves the bound host and returns a redirect',async()=>{
 let calls=0
 const server=createServer((req,res)=>{calls++;expect(req.headers.host).toBe(`api.example.com:${(server.address() as {port:number}).port}`);expect(req.headers.authorization).toBe('Bearer trial-value');res.writeHead(302,{location:'http://127.0.0.1/private'});res.end('trial-value')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const previous=process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE
 process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE='api.example.com=127.0.0.1'
 try {
  const out=await publicFetch(`http://api.example.com:${(server.address() as {port:number}).port}/resource`,{secretRead:true,headers:{Authorization:'Bearer trial-value'}})
  expect(out.status).toBe(302);expect(out.body.toString()).toBe('trial-value');expect(calls).toBe(1)
 }finally{if(previous===undefined)delete process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE;else process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE=previous;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
})

it('masks a mixed escaped echo split across transport chunks before writing a response file',async()=>{
 const {mkdtempSync,readFileSync,rmSync}=await import('node:fs')
 const {tmpdir}=await import('node:os'), {join}=await import('node:path')
 const {SecretVault}=await import('../../src/mms/secrets/SecretVault')
 const {fetchWithSecret}=await import('../../src/mms/secrets/secretFetch')
 const value='sk-proj-AbC/dEf+GhIj0123456789', echo=value.replaceAll('/','\\/').replaceAll('+','\\u002B')
 const folder=mkdtempSync(join(tmpdir(),'fetch-chunks-'))
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write(`{"padding":"${'x'.repeat(70000)}","echo":"${echo.slice(0,16)}`);setImmediate(()=>res.end(`${echo.slice(16)}"}`))})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const previous=process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE;process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE='api.example.com=127.0.0.1'
 try {
  const vault=new SecretVault({profileRoot:folder,threadAlive:()=>true})
  // HTTP exists only in this in-process transport fixture; production bindings require HTTPS.
  vault.store('KEY',value,{threadId:'home',keep:'saved',binding:{origin:'https://api.example.com',header:'Authorization',format:'Bearer {}'}})
  const binding=vi.spyOn(vault,'bindingFor').mockReturnValue({origin:`http://api.example.com:${(server.address() as {port:number}).port}`,header:'Authorization',format:'Bearer {}'})
  const out=await fetchWithSecret(vault,{threadId:'home',folder,args:{secret:'KEY',path:'/read'},signal:new AbortController().signal})
  binding.mockRestore();expect(out.isError).not.toBe(true)
  const text=readFileSync(out.text.split('File: ')[1]!,'utf8');expect(text).not.toContain(echo);expect(text).toContain('[secret KEY hidden]')
 }finally{if(previous===undefined)delete process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE;else process.env.MOUSSE_TEST_SECRET_FETCH_RESOLVE=previous;await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(folder,{recursive:true,force:true})}
})

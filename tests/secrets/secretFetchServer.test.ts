import { expect, it } from 'vitest'
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

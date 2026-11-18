import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as dns from 'node:dns/promises'
import * as https from 'node:https'
import { isPublicAddress, publicFetch, pageFailureReason } from '../src/mms/net-public/publicFetch'
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())
describe('public GET address boundary', () => {
  it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.1.1','100.64.0.1','224.0.0.1','0.0.0.0','192.88.99.1','::1','::','fe80::1','fc00::1','ff02::1','::ffff:127.0.0.1','::ffff:7f00:1','::ffff:192.168.1.1','2002:7f00:1::','64:ff9b::7f00:1'])('refuses %s', address => expect(isPublicAddress(address)).toBe(false))
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])('accepts %s', address => expect(isPublicAddress(address)).toBe(true))
  it('rejects a private DNS answer before connecting', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address:'127.0.0.1', family:4 }] as never)
    const request = vi.spyOn(https, 'request')
    await expect(publicFetch('https://example.com')).rejects.toThrow(/public/)
    expect(request).not.toHaveBeenCalled()
  })
  it('pins the checked address even if DNS changes, preserving Host and SNI', async () => {
    const lookup = vi.spyOn(dns,'lookup').mockResolvedValueOnce([{address:'8.8.8.8',family:4}] as never).mockResolvedValue([{address:'127.0.0.1',family:4}] as never)
    vi.spyOn(https,'request').mockImplementation(((options: any, callback: any) => {
      expect(options.hostname).toBe('example.com'); expect(options.servername).toBe('example.com')
      expect(options.headers.host).toBe('example.com'); expect(options.agent).toBe(false); expect(options.family).toBe(4)
      options.lookup('example.com', {}, (_error: any, address: string) => expect(address).toBe('8.8.8.8'))
      const req = new EventEmitter() as any
      req.end = () => { const res = new EventEmitter() as any; res.statusCode=200; res.headers={}; callback(res); res.emit('data',Buffer.from('ok')); res.emit('end') }
      req.destroy = (e: Error) => req.emit('error',e)
      return req
    }) as any)
    expect((await publicFetch('https://example.com')).body.toString()).toBe('ok')
    expect(lookup).toHaveBeenCalledTimes(1)
  })
  it.each(['file:///etc/passwd','https://user:pass@example.com'])('refuses credentials and non-web URLs: %s', async url => {
    await expect(publicFetch(url)).rejects.toThrow()
  })
})

describe('public GET limits', () => {
  function respond(status: number, headers: Record<string,string>, chunks: Buffer[] = []) {
    vi.mocked(dns.lookup).mockResolvedValue([{address:'8.8.8.8',family:4}] as never)
    vi.mocked(https.request).mockImplementation(((options: any, callback: any) => {
      const req=new EventEmitter() as any
      req.destroy=(error: Error) => req.emit('error',error)
      req.end=()=> {const res=new EventEmitter() as any; res.statusCode=status; res.headers=headers; res.destroy=vi.fn(); callback(res); for(const chunk of chunks) res.emit('data',chunk); res.emit('end')}
      return req
    }) as any)
  }
  it('refuses redirects without requesting their target',async () => {
    respond(302,{location:'http://127.0.0.1/private'})
    await expect(publicFetch('https://example.com')).rejects.toThrow('it moved to 127.0.0.1')
    expect(https.request).toHaveBeenCalledTimes(1)
  })
  it.each([401,404,500])('refuses status %s',async status=> {
    respond(status,{}); await expect(publicFetch('https://example.com')).rejects.toThrow(`HTTP ${status}`)
  })
  it('refuses streamed bodies over 2 MiB even without Content-Length',async () => {
    respond(200,{},[Buffer.alloc(2*1024*1024),Buffer.from('x')])
    await expect(publicFetch('https://example.com')).rejects.toThrow('2 MiB')
  })
  it('accepts exactly 2 MiB',async () => {
    respond(200,{},[Buffer.alloc(2*1024*1024)])
    expect((await publicFetch('https://example.com')).body.length).toBe(2*1024*1024)
  })
  it('bounds DNS resolution itself to 15 seconds',async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(dns.lookup).mockImplementation(() => new Promise(()=>{}))
      const result=expect(publicFetch('https://example.com')).rejects.toThrow('15 seconds')
      await vi.advanceTimersByTimeAsync(15_000); await result
    } finally {vi.useRealTimers()}
  })
  it.each(['2001:2::1','2001:20::1','3fff::1'])('refuses special IPv6 %s',address=>expect(isPublicAddress(address)).toBe(false))
})

// Boundary rows: before, first, last, after. null denotes the edge of the address space.
it.each([
  [null,'0.0.0.0','0.255.255.255','1.0.0.0'],
  ['9.255.255.255','10.0.0.0','10.255.255.255','11.0.0.0'],
  ['100.63.255.255','100.64.0.0','100.127.255.255','100.128.0.0'],
  ['126.255.255.255','127.0.0.0','127.255.255.255','128.0.0.0'],
  ['169.253.255.255','169.254.0.0','169.254.255.255','169.255.0.0'],
  ['172.15.255.255','172.16.0.0','172.31.255.255','172.32.0.0'],
  ['191.255.255.255','192.0.0.0','192.0.0.255','192.0.1.0'],
  ['192.0.1.255','192.0.2.0','192.0.2.255','192.0.3.0'],
  ['192.88.98.255','192.88.99.0','192.88.99.255','192.88.100.0'],
  ['192.167.255.255','192.168.0.0','192.168.255.255','192.169.0.0'],
  ['198.17.255.255','198.18.0.0','198.19.255.255','198.20.0.0'],
  ['198.51.99.255','198.51.100.0','198.51.100.255','198.51.101.0'],
  ['203.0.112.255','203.0.113.0','203.0.113.255','203.0.114.0'],
  ['223.255.255.255','224.0.0.0','255.255.255.255',null],
  ['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff','2001::','2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff','2001:200::'],
  ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff','2001:db8::','2001:db8:ffff:ffff:ffff:ffff:ffff:ffff','2001:db9::'],
  ['2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff','2002::','2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff','2003::'],
  [null,'::','1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff','2000::'],
  ['3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff','3fff::','ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',null],
])('checks both boundaries of %s / %s – %s / %s',(before,first,last,after)=>{
  if(before) expect(isPublicAddress(before),before).toBe(true)
  expect(isPublicAddress(first),first).toBe(false); expect(isPublicAddress(last),last).toBe(false)
  if(after) expect(isPublicAddress(after),after).toBe(true)
})
it.each(['192.0.78.24','192.2.0.0','192.2.255.255','2000::','3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff'])('allows ordinary public %s',address=>expect(isPublicAddress(address)).toBe(true))
it.each(['1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff','4000::','ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'])('refuses outside global IPv6 %s',address=>expect(isPublicAddress(address)).toBe(false))

it('tries the next checked pinned address after a connection failure without resolving again',async()=>{
  vi.mocked(dns.lookup).mockResolvedValue([{address:'2606:4700::1111',family:6},{address:'8.8.8.8',family:4}] as never)
  const connected:string[]=[]
  vi.mocked(https.request).mockImplementation(((options:any,callback:any)=>{
    options.lookup('example.com',{},(_error:any,address:string)=>connected.push(address))
    const req=new EventEmitter() as any
    req.end=()=>{
      if(connected.length===1) { req.emit('error',new Error('ENETUNREACH')); return }
      const res=new EventEmitter() as any; res.statusCode=200; res.headers={}; callback(res); res.emit('data',Buffer.from('ok')); res.emit('end')
    }
    return req
  }) as any)
  expect((await publicFetch('https://example.com')).body.toString()).toBe('ok')
  expect(connected).toEqual(['2606:4700::1111','8.8.8.8']); expect(dns.lookup).toHaveBeenCalledTimes(1)
})

it('reports the deadline reason when a connected request aborts',async()=>{
 vi.useFakeTimers()
 try {
  vi.mocked(dns.lookup).mockResolvedValue([{address:'8.8.8.8',family:4}] as never)
  vi.mocked(https.request).mockImplementation(((options:any)=>{
   const req=new EventEmitter() as any; req.end=()=>{}
   options.signal.addEventListener('abort',()=>req.emit('error',new Error('The operation was aborted')))
   return req
  }) as any)
  const result=expect(publicFetch('https://example.com')).rejects.toThrow('15 seconds')
  await vi.advanceTimersByTimeAsync(15_000);await result
 } finally {vi.useRealTimers()}
})

it.each(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID'])('classifies certificate code %s even through a connection wrapper',code=>{
 const cause=Object.assign(new Error('verification failed'),{code})
 expect(pageFailureReason(new Error('connection failed',{cause}))).toBe("its certificate isn't valid")
})
it.each([
 ['ECONNRESET','Client network socket disconnected before secure TLS connection was established'],
 ['EPROTO','write EPROTO SSL routines:wrong version number'],
 ['ERR_SSL_WRONG_VERSION_NUMBER','SSL wrong version number on a non-TLS port'],
 [undefined,'self-signed certificate'],
])('does not diagnose a certificate from %s or its message', (code,message)=>{
 expect(pageFailureReason(Object.assign(new Error(message),{code}))).toBe('it could not be reached')
})

// Secret reads opt in; page checks retain their defaults above.
it('returns redirects for secret HEAD reads with fixed headers and a port', async () => {
 vi.mocked(dns.lookup).mockResolvedValueOnce([{address:'8.8.8.8',family:4}] as never).mockResolvedValue([{address:'127.0.0.1',family:4}] as never)
 vi.mocked(https.request).mockImplementation(((options:any, callback:any)=>{
  options.lookup('example.com',{},(_error:unknown,address:string)=>expect(address).toBe('8.8.8.8'))
  expect(options.method).toBe('HEAD'); expect(options.port).toBe('8443'); expect(options.headers.Authorization).toBe('Bearer private')
  const req=new EventEmitter() as any; req.end=()=>{const res=new EventEmitter() as any;res.statusCode=302;res.headers={location:'/next'};callback(res);res.emit('end')};return req
 }) as any)
 expect((await publicFetch('https://example.com:8443/path',{method:'HEAD',headers:{Authorization:'Bearer private'},secretRead:true})).status).toBe(302)
 expect(dns.lookup).toHaveBeenCalledTimes(1)
})

it('keeps test address overrides unavailable in packaged builds and without explicit opt in', async () => {
 const { secretFetchTestAddress } = await import('../src/mms/net-public/secretFetchTestAddress')
 expect(secretFetchTestAddress('api.openai.com',{},false)).toBeUndefined()
 const env={MOUSSE_TEST_SECRET_FETCH_RESOLVE:'api.openai.com=127.0.0.1'}
 expect(secretFetchTestAddress('api.openai.com',env,true)).toBeUndefined()
 expect(secretFetchTestAddress('api.openai.com',env,false)).toEqual({address:'127.0.0.1',family:4})
 expect(secretFetchTestAddress('other.com',env,false)).toBeUndefined()
})

it('enforces the secret read 5 MiB bound without changing the page bound',async()=>{
 vi.mocked(dns.lookup).mockResolvedValue([{address:'8.8.8.8',family:4}] as never)
 vi.mocked(https.request).mockImplementation(((_options:any,callback:any)=>{
  const req=new EventEmitter() as any;req.destroy=(e:Error)=>req.emit('error',e)
  req.end=()=>{const res=new EventEmitter() as any;res.statusCode=200;res.headers={};callback(res);res.emit('data',Buffer.alloc(5*1024*1024+1));res.emit('end')};return req
 }) as any)
 await expect(publicFetch('https://example.com',{secretRead:true})).rejects.toThrow('5 MiB')
})
it('aborts secret reads at 30 seconds',async()=>{
 vi.useFakeTimers()
 try {
  vi.mocked(dns.lookup).mockResolvedValue([{address:'8.8.8.8',family:4}] as never)
  vi.mocked(https.request).mockImplementation(((options:any)=>{const req=new EventEmitter() as any;req.end=()=>{};options.signal.addEventListener('abort',()=>req.emit('error',new Error('stopped')));return req}) as any)
  const result=expect(publicFetch('https://example.com',{secretRead:true})).rejects.toThrow('30 seconds')
  await vi.advanceTimersByTimeAsync(30_000);await result
 }finally{vi.useRealTimers()}
})

it('also refuses private DNS answers on authenticated reads',async()=>{
 vi.mocked(dns.lookup).mockResolvedValue([{address:'127.0.0.1',family:4}] as never)
 await expect(publicFetch('https://api.example.com',{secretRead:true,headers:{Authorization:'Bearer private'}})).rejects.toThrow('public')
 expect(https.request).not.toHaveBeenCalled()
})

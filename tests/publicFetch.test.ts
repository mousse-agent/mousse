import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as dns from 'node:dns/promises'
import * as https from 'node:https'
import { isPublicAddress, publicFetch } from '../src/mms/net-public/publicFetch'
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

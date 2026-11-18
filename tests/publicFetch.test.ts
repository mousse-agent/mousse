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
  it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.1.1','100.64.0.1','224.0.0.1','0.0.0.0','::1','::','fe80::1','fc00::1','ff02::1','::ffff:127.0.0.1','::ffff:7f00:1','::ffff:192.168.1.1','2002:7f00:1::','64:ff9b::7f00:1'])('refuses %s', address => expect(isPublicAddress(address)).toBe(false))
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
      expect(options.headers.host).toBe('example.com'); expect(options.agent).toBe(false)
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

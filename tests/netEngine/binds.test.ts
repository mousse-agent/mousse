/**
 * The loopback-only guard of the checks on one computer (`checks/binds.ts`): what each OS's listing says is
 * listening, which of it is this run's, and which addresses count as loopback.
 */
import { describe, expect, it } from 'vitest'
import { descendants, isLoopback, parseLsof, parseNetstat, parseSs } from './checks/binds'

describe('the loopback-only guard', () => {
  it('reads netstat -ano: listening TCP and bound UDP', () => {
    const text = [
      'Active Connections',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:47100          0.0.0.0:0              LISTENING       40',
      '  TCP    127.0.0.1:47101        0.0.0.0:0              LISTENING       41',
      '  TCP    127.0.0.1:47101        127.0.0.1:50000        ESTABLISHED     41',
      '  TCP    [::]:47102             [::]:0                 LISTENING       42',
      '  UDP    0.0.0.0:5353           *:*                                    43',
      '  UDP    [::1]:5000             *:*                                    44'
    ].join('\r\n')
    expect(parseNetstat(text)).toEqual([
      { pid: 40, proto: 'tcp', address: '0.0.0.0', port: 47100 },
      { pid: 41, proto: 'tcp', address: '127.0.0.1', port: 47101 },
      { pid: 42, proto: 'tcp', address: '::', port: 47102 },
      { pid: 43, proto: 'udp', address: '0.0.0.0', port: 5353 },
      { pid: 44, proto: 'udp', address: '::1', port: 5000 }
    ])
  })

  it('reads lsof -nP -i and ss -Hlntup', () => {
    const lsof = [
      'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'mousse-he  501 me    9u  IPv4 0x1234567890      0t0  TCP 127.0.0.1:47100 (LISTEN)',
      'mousse-he  502 me   10u  IPv4 0x1234567891      0t0  TCP *:47101 (LISTEN)',
      'node       503 me   11u  IPv4 0x1234567892      0t0  TCP 127.0.0.1:50000->127.0.0.1:47100 (ESTABLISHED)',
      'mousse-he  504 me   12u  IPv4 0x1234567893      0t0  UDP *:5353'
    ].join('\n')
    expect(parseLsof(lsof)).toEqual([
      { pid: 501, proto: 'tcp', address: '127.0.0.1', port: 47100 },
      { pid: 502, proto: 'tcp', address: '*', port: 47101 },
      { pid: 504, proto: 'udp', address: '*', port: 5353 }
    ])
    const ss = [
      'tcp   LISTEN 0      128        127.0.0.1:47100      0.0.0.0:*    users:(("mousse-helper",pid=601,fd=9))',
      'tcp   LISTEN 0      128          0.0.0.0:47101      0.0.0.0:*    users:(("mousse-helper",pid=602,fd=9))',
      'udp   UNCONN 0      0                  *:5353             *:*    users:(("mousse-helper",pid=603,fd=7))'
    ].join('\n')
    expect(parseSs(ss)).toEqual([
      { pid: 601, proto: 'tcp', address: '127.0.0.1', port: 47100 },
      { pid: 602, proto: 'tcp', address: '0.0.0.0', port: 47101 },
      { pid: 603, proto: 'udp', address: '*', port: 5353 }
    ])
  })

  it('counts only loopback as loopback', () => {
    for (const address of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) expect(isLoopback(address)).toBe(true)
    for (const address of ['0.0.0.0', '::', '*', '192.168.1.5', '100.101.1.2', 'fe80::1']) expect(isLoopback(address)).toBe(false)
  })

  it("takes this process's children and theirs, not its siblings", () => {
    const pairs: Array<[number, number]> = [[11, 10], [12, 11], [13, 1], [14, 13]]
    expect([...descendants(10, pairs)].sort()).toEqual([10, 11, 12])
  })
})

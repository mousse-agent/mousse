import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startDaemon, type Daemon } from './support/daemon'
import { ownedTemp } from './support/tmp'

it('registers every concurrent child before readiness and drains all owners when one boot fails', async () => {
  const temp = ownedTemp('daemon-boot-failure-')
  const entry = join(temp.path, 'owner.mjs')
  writeFileSync(entry, `
    import { writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    const home = process.argv[3]
    if (process.env.FAIL_BOOT === '1') process.exit(9)
    writeFileSync(join(home, 'mms.runtime.json'), JSON.stringify({ pid: process.pid }))
    writeFileSync(join(home, 'mms.owner.json'), JSON.stringify({ pid: process.pid, token: 'fixture', endpoint: 'fixture' }))
    setInterval(() => {}, 1000)
  `)
  const children: Daemon[] = []
  const homes = ['a', 'b', 'c'].map((name) => join(temp.path, name))
  homes.forEach((home) => mkdirSync(home))
  const pending = homes.map((home, index) => startDaemon({
    entry, home, env: { FAIL_BOOT: index === 1 ? '1' : '0' },
    onStart: (daemon) => children.push(daemon)
  }))
  try {
    expect(children).toHaveLength(3)
    await expect(Promise.all(pending)).rejects.toThrow('exited before readiness')
  } finally {
    await Promise.all(children.map((daemon) => daemon.kill()))
    await Promise.allSettled(pending)
    await temp.close()
  }
  expect(children.every((daemon) => daemon.done)).toBe(true)
})

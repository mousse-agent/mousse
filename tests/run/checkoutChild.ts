import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { withCheckoutSlot } from '../../src/mms/worktree/worktreeCheckout'

async function main(): Promise<void> {
  const [operation, one, two, three] = process.argv.slice(2)
  if (operation === 'provision') {
    await new ThreadWorkspaceManager(two!).provision(one!, 'main', three!, undefined, undefined, undefined, { prepared: {} })
  } else if (operation === 'slot') {
    await withCheckoutSlot(one!, async () => {
      writeFileSync(two!, '')
      while (!existsSync(three!)) await delay(20)
    })
  } else {
    throw new Error('Unknown checkout fixture operation')
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })

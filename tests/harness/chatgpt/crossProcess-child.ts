import { ChatGptLifecycle } from '../../../src/mms/harness/chatgpt/lifecycle'

// Another Mousse process changing the same instance: `signOut` or `delete`. No network is used.
const [profileHome, operation] = process.argv.slice(2)

const lifecycle = new ChatGptLifecycle({
  instanceId: 'codex:managed',
  profileHome,
  codec: { canEncrypt: () => false, encrypt: () => null, decrypt: () => null }
})

const run = operation === 'delete' ? lifecycle.deleteInstance() : lifecycle.signOut()
run.then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
)

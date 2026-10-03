import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { profile } from './helpers'

const [home, profileId, chat, mode] = process.argv.slice(2)
const p = await profile({ home, profileId }), rt = p.services.net.runtime()
const checkpoint = rt.db.checkpoint.bind(rt.db)
rt.db.checkpoint = point => {
  if (point === mode) {
    const publication = rt.db.database.prepare('SELECT space,channel FROM net_chat_publications WHERE profile=? AND chat=?').get(profileId, chat)
    const message = rt.db.database.prepare('SELECT event FROM net_chat_message_keys WHERE profile=? AND chat=? AND client_key=?').get(profileId, chat, 'crash-message')
    writeFileSync(join(home, 'chats-crash-public-identities.json'), JSON.stringify({ publication, message }))
    process.kill(process.pid, 'SIGKILL')
  }
  checkpoint(point)
}
if (mode.startsWith('chats.message.')) await p.services.chatNetwork.send({ chatId: chat, text: 'exact crash original', clientMessageId: 'crash-message' })
else p.services.chatNetwork.publish({ chatId: chat, publicationId: 'crash-publication' })
throw new Error('Fixture did not reach the requested crash point')

import type { BotChatMessage } from '../../shared/bots/personal/chat'
import type { BotChatAttachment } from '../../shared/bots/personal/methods'
import { isBotFileRef } from '../../shared/bots/personal/remoteFiles'
import { isQualifiedId } from '../../shared/threadRef'
import { adoptFilePreview } from '../components/bots/fileImageCache'
import { isImageFile } from '../components/bots/imageSources'

/**
 * The files of a bot of another computer, as its chat in this window shows them. Its messages name each file by its
 * place in the bot's files folder there (a relative path); here that place is the file's `remote`, and its `path` is
 * the file's copy on this computer once read (`bots.remote.file`), empty until then, so no path of the other computer
 * ever reaches a read here. Pictures are read as their messages come; other files only when they are sent again
 * (Retry). A chat not opened reads nothing.
 */

/** Reads the copy of a bot's file on this computer (`bots.remote.file`). */
export type RemoteFileRead = (botId: string, ref: string) => Promise<{ path: string }>

/** Each file's copy here, once read, by `botId` and place. */
const copies = new Map<string, string>()
const loading = new Map<string, Promise<string>>()
/** Pictures whose read failed: not read again on their own until the chat is opened again (`forgetFailedRemoteFiles`). */
const failed = new Set<string>()
/** The composer's pictures of files just sent, shown until their copy is read. */
const previews = new Map<string, string>()
const listeners = new Set<(botId: string) => void>()
let generation = 0
/** Bumped for a bot whose copies were forgotten (`forgetRemoteBot`): a read under way for it keeps nothing. */
const forgotten = new Map<string, number>()

const keyOf = (botId: string, ref: string) => `${botId}\n${ref}`

let listedRemote: (botId: string) => boolean = () => false
/** How a listed bot says it lives on another computer (its row's `lives`); the bots store sets it. */
export function setRemoteBotLookup(lookup: (botId: string) => boolean): void {
  listedRemote = lookup
}
/** A bot of another computer: its row says where it lives, or its id is qualified (`<node>:<botId>`). */
export const isRemoteBot = (botId: string): boolean => listedRemote(botId) || isQualifiedId(botId)

type ShownFile = { path: string; remote?: string; previewUrl?: string }

function place<T extends ShownFile>(botId: string, file: T): T {
  const ref = typeof file.remote === 'string' ? file.remote : file.path
  if (!isBotFileRef(ref)) {
    // Not a file of the bot's folder: nothing to show it from, and never a path of that computer read as one of this one.
    if (file.path === '' && file.remote === undefined && file.previewUrl === undefined) return file
    const { remote: _remote, previewUrl: _preview, ...rest } = file
    return { ...rest, path: '' } as T
  }
  const key = keyOf(botId, ref)
  const path = copies.get(key) ?? ''
  const preview = path ? undefined : previews.get(key)
  if (file.path === path && file.remote === ref && file.previewUrl === preview) return file
  const { previewUrl: _preview, ...rest } = file
  return { ...rest, path, remote: ref, ...(preview ? { previewUrl: preview } : {}) } as T
}

/**
 * `messages` of `botId` with their files placed: a bot of another computer's each with its place there (`remote`) and
 * its copy here (`path`, empty until read). A message nothing changed in is the same object; any other bot's are as
 * they are.
 */
export function placeRemoteFiles(botId: string, messages: BotChatMessage[]): BotChatMessage[] {
  if (!isRemoteBot(botId)) return messages
  let changed = false
  const placed = messages.map((message) => {
    const attachments = message.attachments?.map((file) => place(botId, file))
    const cards = message.cards?.map((card) => {
      if (card.type !== 'gallery') return card
      const files = card.files.map((file) => place(botId, file))
      return files.every((file, index) => file === card.files[index]) ? card : { ...card, files }
    })
    const same = (!attachments || attachments.every((file, index) => file === message.attachments![index])) &&
      (!cards || cards.every((card, index) => card === message.cards![index]))
    if (same) return message
    changed = true
    return { ...message, ...(attachments ? { attachments } : {}), ...(cards ? { cards } : {}) }
  })
  return changed ? placed : messages
}

/** Calls `listener` with the bot whose file was just copied here; its chat is placed again. Returns the stop. */
export function onRemoteFileCopied(listener: (botId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The copy of one file of `botId` here, read once at a time. */
function copyOf(botId: string, ref: string, read: RemoteFileRead): Promise<string> {
  const key = keyOf(botId, ref)
  const known = copies.get(key)
  if (known) return Promise.resolve(known)
  const pending = loading.get(key)
  if (pending) return pending
  const owner = generation
  const ownerBot = forgotten.get(botId) ?? 0
  const work = read(botId, ref).then((copy) => {
    if (owner !== generation || ownerBot !== (forgotten.get(botId) ?? 0)) return copy.path
    copies.set(key, copy.path)
    failed.delete(key)
    const preview = previews.get(key)
    if (preview) {
      previews.delete(key)
      adoptFilePreview(copy.path, preview)
    }
    for (const listener of listeners) listener(botId)
    return copy.path
  }).finally(() => { if (loading.get(key) === work) loading.delete(key) })
  loading.set(key, work)
  return work
}

/** Reads the pictures of `messages` (placed) that have no copy here yet. */
export function copyRemotePictures(botId: string, messages: readonly BotChatMessage[], read: RemoteFileRead): void {
  if (!isRemoteBot(botId)) return
  for (const message of messages) {
    const files = [...(message.attachments ?? []), ...(message.cards ?? []).flatMap((card) => (card.type === 'gallery' ? card.files : []))]
    for (const file of files) {
      const ref = file.remote
      if (!ref || file.path || !isImageFile(file.name || ref)) continue
      const key = keyOf(botId, ref)
      if (failed.has(key)) continue
      void copyOf(botId, ref, read).catch(() => { failed.add(key) })
    }
  }
}

/** The pictures of `botId` that could not be read are tried again on their next look (its chat opened again). */
export function forgetFailedRemoteFiles(botId: string): void {
  for (const key of failed) if (key.startsWith(`${botId}\n`)) failed.delete(key)
}

/**
 * The composer's picture of a file just sent to `botId`, shown at its place there until its copy here is read. Takes
 * the URL over.
 */
export function holdRemotePreview(botId: string, ref: string, url: string): void {
  const key = keyOf(botId, ref)
  const copy = copies.get(key)
  if (copy) adoptFilePreview(copy, url)
  else {
    const was = previews.get(key)
    if (was && was !== url) URL.revokeObjectURL(was)
    previews.set(key, url)
  }
}

/** The files to send again (Retry), each as its copy here; a file of another computer's bot is read for it first. */
export async function filesToSend(botId: string, files: ReadonlyArray<{ name: string; path: string; remote?: string }>, read: RemoteFileRead): Promise<BotChatAttachment[]> {
  return Promise.all(files.map(async (file) => ({ name: file.name, path: file.remote ? await copyOf(botId, file.remote, read) : file.path })))
}

/** Forgets what this window kept for a bot of another computer that left its list: its copies, pictures and failures. */
export function forgetRemoteBot(botId: string): void {
  forgotten.set(botId, (forgotten.get(botId) ?? 0) + 1)
  const mine = (key: string) => key.startsWith(`${botId}\n`)
  for (const key of [...copies.keys()]) if (mine(key)) copies.delete(key)
  for (const key of [...loading.keys()]) if (mine(key)) loading.delete(key)
  for (const key of [...failed]) if (mine(key)) failed.delete(key)
  for (const [key, url] of [...previews]) {
    if (!mine(key)) continue
    URL.revokeObjectURL(url)
    previews.delete(key)
  }
}

/** How many copies, reads, failures and pictures this window keeps for `botId` (tests). */
export function remoteFilesKeptFor(botId: string): number {
  const mine = (key: string) => key.startsWith(`${botId}\n`)
  return [...copies.keys(), ...loading.keys(), ...failed, ...previews.keys()].filter(mine).length
}

/** Forgets every copy and picture (a profile switch); tests start clean. */
export function resetRemoteBotFiles(): void {
  generation += 1
  for (const url of previews.values()) URL.revokeObjectURL(url)
  copies.clear()
  loading.clear()
  failed.clear()
  previews.clear()
}

import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
const PLACE_NAMES = new Set('folder folderid parent parentid path dir directory channel channelid repo repository owner project projectid calendar calendarid list listid board to recipient recipients email space spaceid database databaseid drive driveid cc bcc from sender replyto url uri link webhook endpoint host domain account accountid address destination target remote branch'.split(' '))
const normalizedKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '')
const FILE_PLACES = new Set('folder folderid parent parentid path dir directory drive driveid'.split(' '))
const FREE_CONTENT = new Set(['body', 'subject', 'text', 'content'])
export interface ArgumentContract {
  version: 4; keys: string[]; digests: Record<string, string>; varying: string[]
  tokens: Record<string, string[]>; extensions: Record<string, string>
}
const normalizedText = (value: string): string => value.normalize('NFKC').replace(/\p{Cf}/gu, '')
/** Decode each representation once for inspection; callers still send the original argument. */
function scanText(value: string): string {
  const decoded = value.replace(/(?:%[\da-f]{2})+/giu, encoded => {
    try { return decodeURIComponent(encoded) } catch { return encoded.replace(/%([\da-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))) }
  }).replace(/&#(?:x0*([\da-f]{1,6})|0*(\d{1,7}));?/giu, (entity, hex, decimal) => {
    const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10)
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
  const named: Record<string, string> = { period: '.', colon: ':', sol: '/', bsol: '\\', commat: '@', Tab: '\t', NewLine: '\n', nbsp: ' ', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', excl: '!', quest: '?', num: '#', percnt: '%', equals: '=' }
  return decoded.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (entity, name: string) => named[name] ?? entity).normalize('NFKC').replace(/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').replace(/[。｡‧]/g, '.')
}
/** Every scan and edge trim is linear, including text expanded by NFKC. */
function addressTokens(value: string): string[] {
  const text = scanText(value).replace(/\s+/gu, ' ').replace(/ +\. */gu, '.').replace(/ +:/gu, ':').replace(/ +([@/\\]) */gu, '$1')
  const tokens = new Set<string>()
  for (const word of text.split(' ')) {
    let start = 0, end = word.length
    while (start < end && "([{'\"<".includes(word[start]!)) start++
    while (end > start && ".,!?;:)]}'\">".includes(word[end - 1]!)) {
      // The longest plain IPv6 form has 39 characters. Bound this check during a punctuation run.
      if (word[end - 1] === ':' && end - start <= 45 && isIP(word.slice(start, end)) === 6) break
      end--
    }
    const token = word.slice(start, end)
    // Inspect before removing opening quotes so a code fragment such as ".com" is also frozen.
    if (!ordinaryNumber(token) && (/[:@\\]|\/\/|\S\.\S/u.test(word.slice(0, end)) || /&[A-Za-z][A-Za-z0-9]{1,31};/u.test(word))) tokens.add(token)
    if (tokens.size > 256) break
  }
  return [...tokens]
}
/** Bare report numbers are not destinations; four-part dotted IPv4 never matches these forms. */
function ordinaryNumber(token: string): boolean {
  return /^\d{1,2}:\d{2}(?::\d{2})?(?:am|pm)?$/iu.test(token)
    || /^[+-]?\d+(?:,\d{3})*(?:\.\d+)?$/u.test(token)
    || /^(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/u.test(token)
}
function filenameExtension(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value
  if (!name || name.length > 255 || normalizedText(name) !== name || name.includes('..') || /[ .]$/u.test(name)
    || !/^[\p{L}\p{N}][\p{L}\p{N} ._()+,-]*$/u.test(name)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(name.split('.')[0]!.trimEnd())) return undefined
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}
class TooManyAddresses extends Error {}
const tokenDigest = (key: string, field: string, token: string): string => createHmac('sha256', key).update(JSON.stringify([field, token])).digest('hex')
export function argumentContract(args: Record<string, unknown>, tokenKey: string, place?: Record<string, unknown>): ArgumentContract {
  const keys = Object.keys(args).sort()
  const varying = keys.filter(k => FREE_CONTENT.has(normalizedKey(k)) && typeof args[k] === 'string')
  const extensions = Object.fromEntries(keys.filter(k => normalizedKey(k) === 'name' && Object.keys(place ?? {}).some(key => FILE_PLACES.has(normalizedKey(key))) && !!filenameExtension(args[k])).map(k => [k, filenameExtension(args[k])!]))
  const tokens = Object.fromEntries(varying.map(k => [k, addressTokens(args[k] as string)]))
  if (new Set(Object.values(tokens).flat()).size > 256) throw new TooManyAddresses('This sent call has too many addresses to let alone.')
  return { version: 4, keys, digests: Object.fromEntries(keys.map(k => [k, actionDigest(args[k])])), varying: [...varying, ...Object.keys(extensions)], extensions,
    tokens: Object.fromEntries(varying.map(k => [k, tokens[k]!.map(token => tokenDigest(tokenKey, k, token))])) }
}
function argumentsMatch(contract: ArgumentContract | undefined, args: Record<string, unknown>, tokenKey: string): boolean {
  return contract?.version === 4 && actionDigest(Object.keys(args).sort()) === actionDigest(contract.keys)
    && contract.keys.every(k => {
      if (actionDigest(args[k]) === contract.digests[k]) return true
      if (Object.hasOwn(contract.extensions, k)) {
        const extension = filenameExtension(args[k])
        return extension !== undefined && extension === contract.extensions[k]
      }
      if (!contract.varying.includes(k) || !FREE_CONTENT.has(normalizedKey(k)) || typeof args[k] !== 'string') return false
      const allowed = new Set(contract.tokens[k])
      return addressTokens(args[k] as string).every(token => allowed.has(tokenDigest(tokenKey, k, token)))
    })
}
/** Exact top-level destinations declared by the tool; content never supplies authority. */
export function actionPlace(schema: unknown, args: Record<string, unknown>): Record<string, unknown> | undefined {
  const names = PLACE_NAMES
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties
  const entries = Object.keys(properties ?? {}).filter(key => names.has(key.toLowerCase().replace(/[_-]/g, '')) && Object.hasOwn(args, key)).map(key => [key, args[key]])
  return entries.length ? Object.fromEntries(entries) : undefined
}

import type { BotStore } from '../store/BotStore'
import type { BotPermissionItem } from '../../../shared/bots/personal/chat'
import { actionDigest, maskedActionData, readableActionTitle } from './BotActions'

export interface AloneRequest { ask: 'let_alone'; scheduleId: string; serverId: string; tool: string }
interface Exception {
  scheduleId: string; serverId: string; tool: string; place: Record<string, unknown>; placeDigest: string
  arguments: ArgumentContract; binding: unknown; promptDigest: string; grantedAt: string; title: string; askTitle: string
}
interface Host {
  store: BotStore
  enabled(): boolean
  schedule(botId: string, id: string): { prompt: string; name: string } | undefined
  binding(botId: string, server: string, tool: string): unknown | undefined
  schema(server: string, tool: string): unknown
  serverName(server: string, tool: string): string
}
const pendingKey = (activationId: string, request: AloneRequest): string => `alone-ask:${activationId}:${actionDigest(request)}`
export const aloneKey = (r: Pick<AloneRequest, 'scheduleId' | 'serverId' | 'tool'>): string => `alone:${r.scheduleId}:${r.serverId}:${r.tool}`
/** Computer-local authority. Pending consent freezes the facts the owner actually saw. */
export class BotAlone {
  constructor(private readonly host: Host) {}
  private read(botId: string, key: string): Exception | undefined {
    try { return JSON.parse(String(this.host.store.get('SELECT value FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, key)?.value)) } catch { return undefined }
  }
  private put(botId: string, key: string, value: Exception): void {
    this.host.store.run('INSERT INTO bot_memory_state(bot_id, key, value) VALUES(?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value', botId, key, JSON.stringify(value))
  }
  /** One profile-local key; authority state and this key are never included in memory exports. */
  private tokenKey(): string {
    const saved = this.host.store.get("SELECT value FROM bot_memory_state WHERE bot_id = '' AND key = 'alone-token-key'")?.value
    if (typeof saved === 'string') return saved
    this.host.store.run("INSERT OR IGNORE INTO bot_memory_state(bot_id, key, value) VALUES('', 'alone-token-key', ?)", randomBytes(32).toString('hex'))
    return String(this.host.store.get("SELECT value FROM bot_memory_state WHERE bot_id = '' AND key = 'alone-token-key'")!.value)
  }
  private holds(botId: string, entry: Exception): boolean {
    const schedule = this.host.schedule(botId, entry.scheduleId)
    const binding = this.host.binding(botId, entry.serverId, entry.tool)
    const intact = entry.arguments?.version === 4 && !!schedule && actionDigest(schedule.prompt) === entry.promptDigest && (!binding || actionDigest(binding) === actionDigest(entry.binding)) && actionDigest(entry.place) === entry.placeDigest
    if (!intact) this.remove(botId, aloneKey(entry))
    return this.host.enabled() && !!binding && intact
  }
  prepare(botId: string, activationId: string, request: AloneRequest): string | undefined {
    if (!this.host.enabled()) return 'Asks first is off'
    if (this.read(botId, pendingKey(activationId, request))) return undefined
    const schedule = this.host.schedule(botId, request.scheduleId)
    const binding = this.host.binding(botId, request.serverId, request.tool)
    if (!schedule || !this.host.schema(request.serverId, request.tool)) return 'I could not find that automation or MCP tool. Get scheduleId from bot_schedule_list, serverId (id) from mcp_servers, and use the bare tool name.'
    if (!binding) return 'This automation or tool changed. Let it ask once first.'
    if (!actionPlace(this.host.schema(request.serverId, request.tool), Object.fromEntries(Object.keys((this.host.schema(request.serverId, request.tool) as { properties?: object })?.properties ?? {}).map(k => [k, null])))) return "This tool doesn't say where it acts, so it always asks."
    const previous = this.host.store.get(`SELECT a.place_json, a.result_json, a.args_json, a.args_digest FROM bot_actions a JOIN bot_activations w ON w.id = a.activation_id
      WHERE a.bot_id = ? AND a.kind = 'mcp' AND a.status = 'done' AND a.place_json IS NOT NULL
      AND json_extract(w.trigger_json, '$.kind') = 'schedule' AND json_extract(w.trigger_json, '$.scheduleId') = ?
      AND json_extract(a.target_json, '$.server') = ? AND json_extract(a.target_json, '$.tool') = ? ORDER BY a.rowid DESC LIMIT 1`, botId, request.scheduleId, request.serverId, request.tool)
    if (!previous) return 'Let it ask once first. After you send one of these, I can ask to do it alone.'
    const source = JSON.parse(String(previous.args_json)) as Record<string, unknown>
    // The masked review can supply the source only when it is still exactly what was sent.
    if (actionDigest(source) !== previous.args_digest) return 'This sent call has hidden arguments, so it always asks.'
    const place = JSON.parse(String(previous.place_json)) as Record<string, unknown>
    let contract: ArgumentContract
    try { contract = argumentContract(source, this.tokenKey(), place) } catch (error) {
      if (error instanceof TooManyAddresses) return error.message
      throw error
    }
    const result = JSON.parse(String(previous.result_json ?? '{}')).text ?? ''
    const values = Object.values(maskedActionData(place) as object).map(v => placeLabel(v, result)).join(' and ')
    const name = shortAutomationName(schedule.name)
    const toolTitle = readableActionTitle(request.tool)
    const verb = toolTitle.toLowerCase().split(' ')[0]!
    const direct = verb === 'upload' || verb === 'send'
    const action = direct ? `${verb} to` : `use ${toolTitle} in`
    const ongoing = direct ? `${thirdPerson(verb)} to` : `uses ${toolTitle} in`
    this.put(botId, pendingKey(activationId, request), { ...request, arguments: contract, place, placeDigest: actionDigest(place), binding, promptDigest: actionDigest(schedule.prompt), grantedAt: this.host.store.now(), title: `‘${name}’ ${ongoing} ${values} in ${this.host.serverName(request.serverId, request.tool)} without asking`, askTitle: `let ‘${name}’ ${action} ${values} in ${this.host.serverName(request.serverId, request.tool)} without asking` })
  }
  pending(botId: string, activationId: string, request: AloneRequest): { title: string; details: { summary: string; items: string[] } } | undefined {
    const entry = this.read(botId, pendingKey(activationId, request))
    if (!entry) return undefined
    return { title: entry.askTitle, details: { summary: 'Only in this place', items: Object.entries(maskedActionData(entry.place) as object).map(([k,v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`) } }
  }
  answer(botId: string, activationId: string, allow: boolean, request: AloneRequest): boolean {
    const entry = this.read(botId, pendingKey(activationId, request))
    const valid = !allow || !!entry && this.holds(botId, entry)
    if (allow && valid && entry) this.put(botId, aloneKey(entry), { ...entry, grantedAt: this.host.store.now() })
    this.host.store.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', botId, pendingKey(activationId, request))
    return valid
  }
  match(botId: string, scheduleId: string, serverId: string, tool: string, place: Record<string, unknown> | undefined, args: Record<string, unknown>): string | undefined {
    const key = aloneKey({ scheduleId, serverId, tool })
    const entry = this.read(botId, key)
    return entry && place && this.holds(botId, entry) && argumentsMatch(entry.arguments, args, this.tokenKey()) && actionDigest(place) === entry.placeDigest ? key : undefined
  }
  items(botId: string): BotPermissionItem[] {
    return this.host.store.all("SELECT key FROM bot_memory_state WHERE bot_id = ? AND key GLOB 'alone:*'", botId).flatMap(row => {
      const entry = this.read(botId, String(row.key))
      if (!entry || !this.holds(botId, entry)) return []
      return [{ id: String(row.key), title: entry.title, grantedAt: entry.grantedAt,
        note: 'Only this automation, this tool and this place. Anything else asks you first.' }]
    })
  }
  clear(botId: string): void {
    this.host.store.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND (key GLOB 'alone:*' OR key GLOB 'alone-ask:*')", botId)
  }
  cleanPending(botId?: string): void {
    const bots = botId ? [botId] : this.host.store.all("SELECT DISTINCT bot_id FROM bot_memory_state WHERE key GLOB 'alone-ask:*'").map(r => String(r.bot_id))
    for (const id of bots) {
      const open = new Set(this.host.store.openAsks(id).filter(a => 'ask' in a.permission && a.permission.ask === 'let_alone').map(a => pendingKey(a.activationId, a.permission as AloneRequest)))
      for (const row of this.host.store.all("SELECT key FROM bot_memory_state WHERE bot_id = ? AND key GLOB 'alone-ask:*'", id)) if (!open.has(String(row.key))) this.host.store.run('DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ?', id, String(row.key))
    }
  }
  prune(botId: string): void {
    for (const row of this.host.store.all("SELECT key FROM bot_memory_state WHERE bot_id = ? AND key GLOB 'alone:*'", botId)) {
      const entry = this.read(botId, String(row.key))
      if (!entry) continue
      const schedule = this.host.schedule(botId, entry.scheduleId)
      const grant = this.host.store.activeGrant(botId)
      const pair = grant && [grant.manifest, ...this.host.store.disabledPermissions(botId).map(p => p.manifest)].some(manifest => manifest.mcp.some(p => p.serverId === entry.serverId && p.tool === entry.tool))
      if (!pair || !schedule || actionDigest(schedule.prompt) !== entry.promptDigest) this.remove(botId, String(row.key))
    }
  }
  remove(botId: string, key: string): void { this.host.store.run("DELETE FROM bot_memory_state WHERE bot_id = ? AND key = ? AND key GLOB 'alone:*'", botId, key) }
}

/** Keep automation labels readable, including labels already cut by the scheduler. */
function shortAutomationName(name: string): string {
  const text = name.replace(/…$/, '')
  if (text.length <= 48 && !name.endsWith('…')) return text
  const cut = text.slice(0, 48)
  const boundary = cut.lastIndexOf(' ')
  return `${boundary > 0 ? cut.slice(0, boundary) : cut}…`
}
function thirdPerson(verb: string): string {
  return /[^aeiou]y$/.test(verb) ? `${verb.slice(0, -1)}ies` : /(?:s|x|z|ch|sh)$/.test(verb) ? `${verb}es` : `${verb}s`
}

/** A result may supply a display name, never a different comparison value. */
export function placeLabel(value: unknown, result: string, depth = 0): string {
  if (depth > 16) return '…'
  if (value && typeof value === 'object') return Object.values(value).map(v => placeLabel(v, result, depth + 1)).join(' and ')
  let parsed: unknown
  const text = result.startsWith('[What ') ? result.slice(result.indexOf('\n') + 1) : result
  try { parsed = JSON.parse(text) } catch { /* A prose result cannot reliably associate a name with an id. */ }
  const visit = (node: unknown, depth = 0): string | undefined => {
    if (!node || typeof node !== 'object' || depth > 16) return undefined
    const object = node as Record<string, unknown>
    if (typeof value === 'string' && object.id === value && typeof object.name === 'string') return String(maskedActionData(object.name))
    for (const child of Object.values(object)) { const found = visit(child, depth + 1); if (found) return found }
    return undefined
  }
  return visit(parsed) ?? (typeof value === 'string' ? value : JSON.stringify(value))
}

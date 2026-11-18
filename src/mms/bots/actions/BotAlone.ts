const PLACE_NAMES = new Set('folder folderid parent parentid path dir directory channel channelid repo repository owner project projectid calendar calendarid list listid board to recipient recipients email space spaceid database databaseid drive driveid cc bcc from sender replyto url uri link webhook endpoint host domain account accountid address destination target remote branch'.split(' '))
const normalizedKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '')
const FREE_CONTENT = new Set(['body', 'name', 'subject', 'text', 'content'])
export interface ArgumentContract { keys: string[]; digests: Record<string, string>; varying: string[] }
/** Addresses and nested destinations cannot gain authority through a content field. */
function restricted(value: unknown, depth = 0): boolean {
  if (depth > 64) return true
  if (typeof value === 'string') return /[a-z][a-z0-9+.-]*:\/\/|(?:[\p{L}\p{N}_-]+\.)+[\p{L}]{2,}|@/iu.test(value)
  if (Array.isArray(value)) return value.some(v => restricted(v, depth + 1))
  return !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => PLACE_NAMES.has(normalizedKey(k)) || restricted(v, depth + 1))
}
export function argumentContract(args: Record<string, unknown>): ArgumentContract {
  const keys = Object.keys(args).sort()
  return { keys, digests: Object.fromEntries(keys.map(k => [k, actionDigest(args[k])])), varying: keys.filter(k => FREE_CONTENT.has(normalizedKey(k)) && !restricted(args[k])) }
}
function argumentsMatch(contract: ArgumentContract | undefined, args: Record<string, unknown>): boolean {
  return !!contract && actionDigest(Object.keys(args).sort()) === actionDigest(contract.keys)
    && contract.keys.every(k => contract.varying.includes(k) && !restricted(args[k]) || actionDigest(args[k]) === contract.digests[k])
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
  private holds(botId: string, entry: Exception): boolean {
    const schedule = this.host.schedule(botId, entry.scheduleId)
    const binding = this.host.binding(botId, entry.serverId, entry.tool)
    return this.host.enabled() && !!binding && !!schedule && actionDigest(schedule.prompt) === entry.promptDigest && actionDigest(binding) === actionDigest(entry.binding) && actionDigest(entry.place) === entry.placeDigest
  }
  prepare(botId: string, activationId: string, request: AloneRequest): string | undefined {
    if (!this.host.enabled()) return 'Asks first is off'
    if (this.read(botId, pendingKey(activationId, request))) return undefined
    const schedule = this.host.schedule(botId, request.scheduleId)
    const binding = this.host.binding(botId, request.serverId, request.tool)
    if (!schedule || !this.host.schema(request.serverId, request.tool)) return 'I could not find that automation or MCP tool. Get scheduleId from bot_schedule_list, serverId (id) from mcp_servers, and use the bare tool name.'
    if (!binding) return 'This automation or tool changed. Let it ask once first.'
    if (!actionPlace(this.host.schema(request.serverId, request.tool), Object.fromEntries(Object.keys((this.host.schema(request.serverId, request.tool) as { properties?: object })?.properties ?? {}).map(k => [k, null])))) return "This tool doesn't say where it acts, so it always asks."
    const previous = this.host.store.get(`SELECT a.place_json, a.result_json, a.bot_note FROM bot_actions a JOIN bot_activations w ON w.id = a.activation_id
      WHERE a.bot_id = ? AND a.kind = 'mcp' AND a.status = 'done' AND a.place_json IS NOT NULL
      AND json_extract(w.trigger_json, '$.kind') = 'schedule' AND json_extract(w.trigger_json, '$.scheduleId') = ?
      AND json_extract(a.target_json, '$.server') = ? AND json_extract(a.target_json, '$.tool') = ? ORDER BY a.rowid DESC LIMIT 1`, botId, request.scheduleId, request.serverId, request.tool)
    if (!previous) return 'Let it ask once first. After you send one of these, I can ask to do it alone.'
    if (!previous.bot_note) return 'Let it ask once first. After you send one of these, I can ask to do it alone.'
    const contract = JSON.parse(String(previous.bot_note)) as ArgumentContract
    const place = JSON.parse(String(previous.place_json)) as Record<string, unknown>
    const result = JSON.parse(String(previous.result_json ?? '{}')).text ?? ''
    const values = Object.values(maskedActionData(place) as object).map(v => placeLabel(v, result)).join(' and ')
    const name = shortAutomationName(schedule.name)
    const verb = readableActionTitle(request.tool).toLowerCase().split(' ')[0]!
    this.put(botId, pendingKey(activationId, request), { ...request, arguments: contract, place, placeDigest: actionDigest(place), binding, promptDigest: actionDigest(schedule.prompt), grantedAt: this.host.store.now(), title: `‘${name}’ ${thirdPerson(verb)} to ${values} in ${this.host.serverName(request.serverId, request.tool)} without asking`, askTitle: `let ‘${name}’ ${verb} to ${values} in ${this.host.serverName(request.serverId, request.tool)} without asking` })
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
    return entry && place && argumentsMatch(entry.arguments, args) && this.holds(botId, entry) && actionDigest(place) === entry.placeDigest ? key : undefined
  }
  items(botId: string): BotPermissionItem[] {
    return this.host.store.all("SELECT key FROM bot_memory_state WHERE bot_id = ? AND key GLOB 'alone:*'", botId).flatMap(row => {
      const entry = this.read(botId, String(row.key))
      if (!entry) return []
      return [{ id: String(row.key), title: entry.title, grantedAt: entry.grantedAt,
        note: this.holds(botId, entry) ? 'Only this automation, this tool and this place. Anything else asks you first.' : 'Send a call from this automation and ask again.',
        ...(!this.holds(botId, entry) ? { mark: 'Changed' } : {}) }]
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
      const pair = this.host.store.activeGrant(botId)?.manifest.mcp.some(p => p.serverId === entry.serverId && p.tool === entry.tool)
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
export function placeLabel(value: unknown, result: string): string {
  if (Array.isArray(value)) return value.map(v => placeLabel(v, result)).join(' and ')
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

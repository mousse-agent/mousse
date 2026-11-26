import { randomUUID, createHash } from 'node:crypto'
import type { BotStore } from '../store/BotStore'
import type { ToolOutcome } from '../../run/mcp/appTools/types'
import {
  BOT_ALONE_DAILY_CALLS,
  BOT_ALONE_HOURLY_CALLS
} from '../../../shared/bots/personal/definition'

export interface SecretFetchActionInput {
  botId: string
  activationId: string
  /** The activation's lane: a read from the chat is the chat's. Absent: `run`. */
  lane?: 'chat' | 'run'
  callKey: string
  secret: string
  service: string
  args: Record<string, unknown>
  refusal?: string
  mask(text: string): string
  now?: number
}
/** Admission and insertion are synchronous and transactional: concurrent reads reserve their cap before awaiting IO. */
export async function secretFetchAction(
  store: BotStore,
  input: SecretFetchActionInput,
  run: (refuseWithoutCounting: () => void) => Promise<ToolOutcome>
): Promise<ToolOutcome> {
  const { botId, activationId, callKey, mask } = input
  const at = input.now ?? Date.now(),
    now = new Date(at).toISOString()
  const admission = store.db.transaction(() => {
    const previous = store.get(
      'SELECT status, result_json FROM bot_actions WHERE call_key = ?',
      callKey
    )
    if (previous)
      return {
        previous: previous.result_json
          ? (JSON.parse(String(previous.result_json)) as ToolOutcome)
          : { text: 'This read is already running.', isError: true }
      }
    const count = (since: number, secret?: string): number =>
      Number(
        store.get(
          `SELECT count(*) AS n FROM bot_actions WHERE kind = 'secret_fetch' AND ran_at > ? AND ${secret === undefined ? 'bot_id = ?' : "json_extract(binding_json, '$.secretDigest') = ?"}`,
          new Date(since).toISOString(),
          secret === undefined ? botId : createHash('sha256').update(secret).digest('hex')
        )?.n ?? 0
      )
    const refusal =
      input.refusal ??
      (count(at - 3600000, input.secret) >= BOT_ALONE_HOURLY_CALLS
        ? `You've read from ${input.service} ${BOT_ALONE_HOURLY_CALLS} times this hour; try again later or tell your owner.`
        : count(at - 86400000) >= BOT_ALONE_DAILY_CALLS
          ? `You've made ${BOT_ALONE_DAILY_CALLS} service reads in the last day; try again later or tell your owner.`
          : undefined)
    // Header values are never needed in the action history, including rejected foreign credentials.
    const historyArgs = { ...input.args }
    if (Object.hasOwn(historyArgs, 'headers')) {
      const headers = historyArgs.headers
      historyArgs.headers =
        headers && typeof headers === 'object' && !Array.isArray(headers)
          ? Object.keys(headers)
          : []
    }
    const id = randomUUID(),
      args = mask(JSON.stringify(historyArgs))
    store.run(
      `INSERT INTO bot_actions(id,call_key,bot_id,activation_id,lane,kind,target_json,args_json,args_digest,binding_json,status,created_at,answered_at) VALUES(?,?,?,?,?,'secret_fetch',?,?,?,?,'approved',?,?)`,
      id,
      callKey,
      botId,
      activationId,
      input.lane ?? 'run',
      mask(JSON.stringify({ service: input.service })),
      args,
      createHash('sha256').update(args).digest('hex'),
      JSON.stringify({ secretDigest: createHash('sha256').update(input.secret).digest('hex') }),
      now,
      now
    )
    if (!refusal)
      store.run("UPDATE bot_actions SET status = 'running', ran_at = ? WHERE id = ?", now, id)
    return { id, refusal }
  })
  if ('previous' in admission) return admission.previous!
  let counted = true
  let result: ToolOutcome
  try {
    result = admission.refusal
      ? { text: admission.refusal, isError: true }
      : await run(() => {
          counted = false
        })
  } catch {
    result = { text: 'The service read could not finish.', isError: true }
  }
  result = { text: mask(result.text), ...(result.isError ? { isError: true } : {}) }
  store.run(
    'UPDATE bot_actions SET status = ?, result_json = ?, ran_at = CASE WHEN ? THEN ran_at ELSE NULL END WHERE id = ?',
    result.isError ? 'failed' : 'done',
    JSON.stringify(result),
    counted ? 1 : 0,
    admission.id!
  )
  return result
}

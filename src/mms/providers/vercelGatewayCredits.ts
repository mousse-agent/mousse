import type { ProviderUsage, UsageCredit, UsageProblem } from '../../shared/providerAuth'

/**
 * Vercel AI Gateway credits (`GET /v1/credits`, documented in the AI Gateway REST API): the team's
 * balance and lifetime spend in USD, read with the gateway API key Mousse already stores. Read only;
 * the key goes to this one address and is never logged.
 */
export const VERCEL_GATEWAY_CREDITS_URL = 'https://ai-gateway.vercel.sh/v1/credits'
export const VERCEL_CREDITS_TIMEOUT_MS = 8_000
const MAX_BODY_BYTES = 64 * 1024

export type CreditsFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; text(): Promise<string> }>

/** A USD amount the gateway sends as a decimal string ("95.50", live with ten places) or a number; undefined for anything else. */
function usd(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d{1,12}(\.\d{1,20})?$/.test(value.trim()) ? Number(value) : Number.NaN
  return Number.isFinite(number) ? number : undefined
}

/** The balance and spend of a `/v1/credits` reply, or undefined when it has no balance. */
export function parseVercelCredits(value: unknown): UsageCredit | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  const balance = usd(body.balance)
  if (balance === undefined) return undefined
  const used = usd(body.total_used)
  return { balanceUsd: balance, ...(used !== undefined && used >= 0 ? { usedUsd: used } : {}) }
}

export type CreditsUsage = Pick<ProviderUsage, 'status' | 'windows' | 'message' | 'credit' | 'problem'>

/** The gateway's credits for this key: the balance, or "Key rejected" / "Not reachable" / why not. */
export async function readVercelGatewayCredits(apiKey: string, options: { fetch?: CreditsFetch; timeoutMs?: number } = {}): Promise<CreditsUsage> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as CreditsFetch)
  const failed = (message: string, problem: UsageProblem = 'unavailable'): CreditsUsage => ({ status: 'error', windows: [], message, problem })
  let response: { status: number; text(): Promise<string> }
  try {
    response = await fetchImpl(VERCEL_GATEWAY_CREDITS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? VERCEL_CREDITS_TIMEOUT_MS),
      // The key goes to the gateway only, never on to wherever a redirect points.
      redirect: 'error'
    })
  } catch {
    return failed('Not reachable')
  }
  if (response.status === 401 || response.status === 403) return failed('Key rejected', 'key_rejected')
  if (response.status === 429) return failed('Rate limited')
  if (response.status < 200 || response.status >= 300) return failed('Not reachable')
  let body: unknown
  try {
    const text = await response.text()
    body = text.length > MAX_BODY_BYTES ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  const credit = parseVercelCredits(body)
  return credit ? { status: 'available', windows: [], credit } : failed('No balance reported')
}

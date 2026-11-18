/** A service binding is metadata only. Methods are always GET/HEAD; E4 performs requests. */
export interface SecretBinding {
  /** Known services persist only this id; their current table entry supplies authority. */
  serviceId?: string
  origin: string
  header: string
  format: string
  paths?: string[]
  service?: string
  headers?: Record<string, string>
}
export interface SecretBindingView { service?: string; host: string; readOnly: true }

/** Paths match whole segments after decoding: `/user` must not match `/users`.
 * Read prefixes are deliberately limited to documented API resources, never website or credential-management paths. */
export const SECRET_SERVICES: Record<string, SecretBinding> = {
  openai: { service: 'OpenAI', origin: 'https://api.openai.com', header: 'Authorization', format: 'Bearer {}', paths: ['/v1/models', '/v1/files', '/v1/batches', '/v1/vector_stores'] },
  anthropic: { service: 'Anthropic', origin: 'https://api.anthropic.com', header: 'x-api-key', format: '{}', paths: ['/v1/models', '/v1/files', '/v1/messages/batches'], headers: { 'anthropic-version': '2023-06-01' } },
  github: { service: 'GitHub', origin: 'https://api.github.com', header: 'Authorization', format: 'Bearer {}', paths: ['/repos', '/user', '/users', '/orgs', '/search', '/notifications', '/issues'] },
  stripe: { service: 'Stripe', origin: 'https://api.stripe.com', header: 'Authorization', format: 'Bearer {}', paths: ['/v1/customers', '/v1/charges', '/v1/balance', '/v1/payment_intents', '/v1/subscriptions', '/v1/invoices', '/v1/products', '/v1/prices'] },
  notion: { service: 'Notion', origin: 'https://api.notion.com', header: 'Authorization', format: 'Bearer {}', paths: ['/v1/users', '/v1/pages', '/v1/blocks', '/v1/databases', '/v1/data_sources'], headers: { 'Notion-Version': '2026-03-11' } },
  huggingface: { service: 'Hugging Face', origin: 'https://huggingface.co', header: 'Authorization', format: 'Bearer {}', paths: ['/api/models', '/api/datasets', '/api/spaces', '/api/whoami-v2'] }
}

export function secretBindingView(binding: SecretBinding): SecretBindingView {
  return { ...(binding.service ? { service: binding.service } : {}), host: new URL(binding.origin).host, readOnly: true }
}

/** Labels do not affect authority. Paths and fixed headers do. Order does not. */
export function sameSecretBinding(a: SecretBinding | undefined, b: SecretBinding | undefined): boolean {
  if (!a || !b) return a === b
  if (!a.header || !b.header) return false
  if (a.serviceId && b.serviceId) return a.serviceId === b.serviceId
  const headers = (value: SecretBinding) => Object.entries(value.headers ?? {}).map(([k,v]) => [k.toLowerCase(),v]).sort(([a],[b]) => a.localeCompare(b))
  return a.origin === b.origin && a.header.toLowerCase() === b.header.toLowerCase() && a.format === b.format &&
    JSON.stringify(a.paths ? [...a.paths].sort() : null) === JSON.stringify(b.paths ? [...b.paths].sort() : null) && JSON.stringify(headers(a)) === JSON.stringify(headers(b))
}

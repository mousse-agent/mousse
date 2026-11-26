import { forwardRef } from 'react'
import type { ProviderUsage } from '../../shared/providerAuth'
import { normalizeProviderId, ProviderIcon } from './providerIcons'
import type { IconComponent } from './icons'

/** The company behind each provider, by its normalized id, for the usage page's names. */
const COMPANIES: Record<string, string> = {
  openai: 'OpenAI',
  claude: 'Anthropic',
  anthropic: 'Anthropic',
  google: 'Google',
  antigravity: 'Google',
  copilot: 'GitHub',
  cursor: 'Cursor',
  aws: 'Amazon',
  azure: 'Microsoft',
  xai: 'xAI',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  kimi: 'Moonshot AI',
  moonshot: 'Moonshot AI',
  zai: 'Z.ai',
  zhipu: 'Zhipu AI',
  minimax: 'MiniMax',
  openrouter: 'OpenRouter',
  vercel: 'Vercel',
  groq: 'Groq',
  fireworks: 'Fireworks',
  together: 'Together AI',
  cerebras: 'Cerebras',
  huggingface: 'Hugging Face',
  nvidia: 'NVIDIA',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode',
  qwen: 'Alibaba',
  cloudflare: 'Cloudflare',
  baseten: 'Baseten',
  xiaomi: 'Xiaomi',
  meta: 'Meta',
  cohere: 'Cohere',
  antgroup: 'Ant Group'
}

/**
 * A provider as the usage page names it: its company first, then the product ("OpenAI · ChatGPT Codex", whose plan
 * follows as "Plus"). A label that already names the company ("Grok (xAI)"), or a provider without a known one, stays as is.
 */
export function usageProviderTitle(provider: Pick<ProviderUsage, 'id' | 'label'>): string {
  const normalized = normalizeProviderId(provider.id)
  const company = COMPANIES[normalized]
  // Codex's limits are the ChatGPT plan's.
  const label = normalized === 'openai' && provider.label === 'Codex' ? 'ChatGPT Codex' : provider.label
  if (!company || label.toLowerCase().includes(company.toLowerCase())) return label
  return `${company} · ${label}`
}

const logos = new Map<string, IconComponent>()

/** The provider's logo as a heading glyph, one component per provider so a card keeps it across renders. */
export function providerLogo(providerId: string): IconComponent {
  const normalized = normalizeProviderId(providerId)
  let logo = logos.get(normalized)
  if (!logo) {
    logo = forwardRef<SVGSVGElement, { size?: number | string; className?: string }>(function ProviderLogo({ size, className }, _ref) {
      return <ProviderIcon providerId={normalized} size={typeof size === 'number' ? size : 15} {...(className ? { className } : {})} />
    }) as unknown as IconComponent
    logos.set(normalized, logo)
  }
  return logo
}

/** A provider's logo and name on one line, for the page's slim rows. */
export function UsageProviderName({ provider }: { provider: Pick<ProviderUsage, 'id' | 'label'> }) {
  return <span className="usage-provider-name">
    <ProviderIcon providerId={provider.id} size={14} className="usage-provider-logo" />
    <span className="usage-provider-name-text">{usageProviderTitle(provider)}</span>
  </span>
}

import type { ReactNode } from 'react'

interface ProviderIconProps {
  providerId: string
  size?: number
  className?: string
}

function MonogramIcon({ label, size = 14, className }: { label: string; size?: number; className?: string }) {
  return (
    <span
      className={className}
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 4,
        fontSize: Math.max(8, size * 0.55),
        fontWeight: 600,
        lineHeight: 1,
        background: 'rgba(var(--accent-rgb), 0.2)',
        color: 'var(--text-secondary)',
        flexShrink: 0
      }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  )
}

function SvgIcon({
  size = 14,
  className,
  children
}: {
  size?: number
  className?: string
  children: React.ReactNode
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  )
}

const PROVIDER_ICONS: Record<string, (props: { size?: number; className?: string }) => ReactNode> = {
  anthropic: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M13.83 3.5 8.5 20.5h-2.4L11.42 3.5h2.41Zm6.9 0-5.33 17H14l5.33-17h1.5Z" />
    </SvgIcon>
  ),
  openai: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M12 2.5a7.2 7.2 0 0 1 6.2 10.7 5.8 5.8 0 0 1-2.4 10.5A7.2 7.2 0 0 1 5.8 13.3 5.8 5.8 0 0 1 12 2.5Zm0 1.8a4 4 0 0 0-3.2 6.3l.2.3-1.1 1.9a4 4 0 0 0 1.5 5.5 4 4 0 0 0 5.5-1.5l1.1-1.9.3.2a4 4 0 0 0 5.5-1.5 4 4 0 0 0-1.5-5.5l-1.9-1.1.2-.3A4 4 0 0 0 12 4.3Z" />
    </SvgIcon>
  ),
  google: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M12 5.5c1.5 0 2.8.5 3.8 1.5l2.8-2.8C16.9 2.6 14.6 1.5 12 1.5 7.7 1.5 4 4.2 2.5 8l3.3 2.6C6.6 7.7 9.1 5.5 12 5.5Zm8.5 3.5c-.3-1-1-2.5-1.7-3.4l-3.3 2.6c.3.8.5 1.7.5 2.8 0 1.1-.2 2-.5 2.8l3.3 2.6c1.2-2.2 1.7-4.6 1.7-7.4ZM12 18.5c-2.9 0-5.4-2.2-6.2-5.1L2.5 16c1.5 3.8 5.2 6.5 9.5 6.5 2.6 0 4.9-1.1 6.6-2.8l-2.8-2.8c-1 .9-2.3 1.6-3.8 1.6Z" />
    </SvgIcon>
  ),
  openrouter: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M4 12a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm3.5-3.5 7 7 1.4-1.4-7-7-1.4 1.4Zm1.4 7 7-7-1.4-1.4-7 7 1.4 1.4Z" />
    </SvgIcon>
  ),
  deepseek: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M12 3 4 8v8l8 5 8-5V8l-8-5Zm0 2.2 5.5 3.4v6.8L12 19.8 6.5 15.8V8.6L12 5.2Z" />
    </SvgIcon>
  ),
  xai: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M5 5h4.2l2.8 4.5L14.8 5H19l-5.8 8.5L19 19h-4.2l-2.8-4.5L9.2 19H5l5.8-8.5L5 5Z" />
    </SvgIcon>
  ),
  mistral: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M4 5h3v14H4V5Zm4 0h3v14H8V5Zm4 0h3v14h-3V5Zm4 0h3v14h-3V5Z" />
    </SvgIcon>
  ),
  groq: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M6 6h12v3H6V6Zm0 4.5h12v3H6v-3Zm0 4.5h8v3H6v-3Z" />
    </SvgIcon>
  ),
  meta: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M12 5.5c2.2 0 4 3.5 4 6.5s-1.8 6.5-4 6.5-4-3.5-4-6.5 1.8-6.5 4-6.5Zm-6 0c2.2 0 4 3.5 4 6.5s-1.8 6.5-4 6.5-4-3.5-4-6.5 1.8-6.5 4-6.5Zm12 0c2.2 0 4 3.5 4 6.5s-1.8 6.5-4 6.5-4-3.5-4-6.5 1.8-6.5 4-6.5Z" />
    </SvgIcon>
  ),
  cohere: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z" />
    </SvgIcon>
  ),
  cursor: ({ size, className }) => (
    <SvgIcon size={size} className={className}>
      <path d="M12 3.5 7.2 19.5h2.1l1-3.6h5.4l1 3.6h2.1L14.8 3.5h-2.8Zm1.4 5.2 1.9 6.8h-3.8l1.9-6.8Z" />
    </SvgIcon>
  )
}

function normalizeProviderId(providerId: string): string {
  const id = providerId.toLowerCase()
  if (id.includes('anthropic')) return 'anthropic'
  if (id.includes('openai')) return 'openai'
  if (id.includes('google') || id.includes('gemini') || id.includes('vertex')) return 'google'
  if (id.includes('openrouter')) return 'openrouter'
  if (id.includes('deepseek')) return 'deepseek'
  if (id.includes('xai') || id.includes('grok')) return 'xai'
  if (id.includes('mistral')) return 'mistral'
  if (id.includes('groq')) return 'groq'
  if (id.includes('meta') || id.includes('llama')) return 'meta'
  if (id.includes('cohere')) return 'cohere'
  if (id === 'cursor' || id.includes('cursor')) return 'cursor'
  return id
}

export function ProviderIcon({ providerId, size = 14, className }: ProviderIconProps) {
  const normalized = normalizeProviderId(providerId)
  const Icon = PROVIDER_ICONS[normalized]
  if (Icon) {
    return <Icon size={size} className={className} />
  }
  const label = providerId.split(/[-_/]/).pop() || providerId
  return <MonogramIcon label={label} size={size} className={className} />
}

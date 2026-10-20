import type { PlusStatus } from '../../mms/net/plus/contracts'
import { UserCircle } from '../lib/icons'
import { mousseIdName } from '../stores/mousseIdStore'

const PALETTE = ['#4d6088', '#604880', '#2f7a6a', '#8a5a3c', '#7a3f5c', '#3f6f8a', '#6b7a2f', '#5a4d88']

function colorFor(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

/** Initials avatar for the signed-in Mousse ID account, or a person icon when signed out. */
export function MousseIdAvatar({ plus, large = false }: { plus?: PlusStatus; large?: boolean }) {
  const className = `profile-avatar mousse-id-avatar${large ? ' profile-avatar-large' : ''}`
  if (!plus?.connected) {
    return <span className={`${className} mousse-id-avatar-empty`} aria-hidden="true"><UserCircle size={large ? 22 : 16} strokeWidth={1.8} /></span>
  }
  const name = mousseIdName(plus)
  return (
    <span className={className} style={{ background: colorFor(plus.email ?? plus.accountId ?? name) }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

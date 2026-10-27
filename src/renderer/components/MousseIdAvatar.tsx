import type { PlusStatus } from '../../shared/net/local'
import { UserCircle } from '../lib/icons'
import { paletteColorFor } from '../lib/profilePalette'
import { mousseIdName } from '../stores/mousseIdStore'

/** Initials avatar for the signed-in Mousse ID account, or a person icon when signed out. */
export function MousseIdAvatar({ plus, large = false }: { plus?: PlusStatus; large?: boolean }) {
  const className = `profile-avatar mousse-id-avatar${large ? ' profile-avatar-large' : ''}`
  if (!plus?.connected) {
    return <span className={`${className} mousse-id-avatar-empty`} aria-hidden="true"><UserCircle size={large ? 22 : 16} strokeWidth={1.8} /></span>
  }
  const name = mousseIdName(plus)
  return (
    <span className={className} style={{ background: paletteColorFor(plus.email ?? plus.accountId ?? name) }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

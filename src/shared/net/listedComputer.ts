/**
 * Whether a device of the roster is one of the user's computers (the lists of threads, and the names an editor
 * opens, both use this). The kind the authority recorded wins (a phone never is); a device whose kind is not
 * known on this computer is a computer only if its signed delegation holds "Works on threads" (`settings`),
 * which only computers are given. Only the authority records kinds, so on every other computer most devices
 * have none, and this is what tells the authority and the other computers apart from phones there.
 */
export function isListedComputer(
  kind: 'computer' | 'phone' | undefined,
  caps: readonly string[]
): boolean {
  if (kind === 'phone') return false
  return kind === 'computer' || caps.includes('settings')
}

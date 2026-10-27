/**
 * `bridge join --via`: where a joining machine reaches the inviting machine first. It exists for a
 * remote machine set up over SSH, which reaches this computer through a reverse tunnel on its own
 * loopback interface. Only that shape is accepted: no other host, no `[::1]`, no userinfo, query
 * or hash. The pinned TLS check against the inviter's key is unchanged.
 */
const VIA = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mousse-net$/u

export function isJoinVia(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const match = VIA.exec(value)
  return !!match && Number(match[1]) <= 65535
}

import { isId } from '../../../shared/net'
import type { SpaceId } from '../../../shared/net'
import { NetDatabase, fail, integer, json } from './database'

/** Host-created scope. Callers must authorize its profile/space independently. */
export type StorageLimitScope = { kind: 'profile'; profileId: string } | { kind: 'space'; space: SpaceId }

/** Explicit accounting only: no default policy silently applies to all writes. */
export class SqliteQuotaRateLedger {
  constructor(private readonly db: NetDatabase) {}
  configureQuota(scope: StorageLimitScope, maximumUnits: number): void {
    const key = this.scope(scope); integer(maximumUnits)
    this.db.transaction(() => {
      if (this.quotaUsed(key) > maximumUnits) fail('quota_exceeded', 'Quota is below existing accounted reservations.')
      this.db.charge(1)
      this.db.database.prepare('INSERT INTO net_quota_config VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET units=excluded.units').run(key, maximumUnits)
    })
  }
  reserveQuota(scope: StorageLimitScope, reservationId: string, units: number): void {
    const key = this.scope(scope); this.id(reservationId); integer(units)
    this.db.transaction(() => {
      const previous = this.db.database.prepare('SELECT units,released FROM net_quota_reservations WHERE scope=? AND id=?').get(key, reservationId)
      if (previous) { if (previous.units !== units) fail('conflict', 'Quota reservation identity changed.'); return }
      const maximum = this.db.database.prepare('SELECT units FROM net_quota_config WHERE scope=?').get(key)
      if (!maximum) fail('quota_exceeded', 'Scope has no explicit quota configuration.')
      if (integer(this.quotaUsed(key) + units) > Number(maximum.units)) fail('quota_exceeded', 'Storage quota is already allocated.')
      this.db.charge(1)
      this.db.database.prepare('INSERT INTO net_quota_reservations VALUES(?,?,?,0)').run(key, reservationId, units)
    })
  }
  releaseQuota(scope: StorageLimitScope, reservationId: string): void {
    const key = this.scope(scope); this.id(reservationId)
    this.db.transaction(() => {
      const existing = this.db.database.prepare('SELECT released FROM net_quota_reservations WHERE scope=? AND id=?').get(key, reservationId)
      if (!existing) fail('bad_request', 'Unknown quota reservation.')
      if (existing.released) return
      this.db.charge(1)
      this.db.database.prepare('UPDATE net_quota_reservations SET released=1 WHERE scope=? AND id=?').run(key, reservationId)
    })
  }
  remainingQuota(scope: StorageLimitScope): number {
    const key = this.scope(scope)
    const maximum = this.db.database.prepare('SELECT units FROM net_quota_config WHERE scope=?').get(key)
    return maximum ? integer(Number(maximum.units) - this.quotaUsed(key)) : 0
  }
  configureRate(scope: StorageLimitScope, principal: string, maximumUnits: number, windowMs: number): void {
    const key = this.scope(scope); this.id(principal); integer(maximumUnits, 1); integer(windowMs, 1)
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database.prepare('INSERT INTO net_rate_config VALUES(?,?,?,?,0) ON CONFLICT(scope,principal) DO UPDATE SET max_units=excluded.max_units,window_ms=excluded.window_ms').run(key, principal, maximumUnits, windowMs)
    })
  }
  chargeRate(scope: StorageLimitScope, principal: string, operationId: string, now: number, units = 1): void {
    const key = this.scope(scope); this.id(principal); this.id(operationId); integer(now); integer(units, 1)
    this.db.transaction(() => {
      const previous = this.db.database.prepare('SELECT units FROM net_rate_charges WHERE scope=? AND principal=? AND id=?').get(key, principal, operationId)
      if (previous) { if (previous.units !== units) fail('conflict', 'Rate operation identity changed.'); return }
      const config = this.db.database.prepare('SELECT * FROM net_rate_config WHERE scope=? AND principal=?').get(key, principal)
      if (!config) fail('rate_limited', 'Principal has no explicit rate configuration.')
      if (now < Number(config.last_now)) fail('clock_skew', 'Rate clock moved backwards; wait or reconcile before charging.')
      const used = this.rateUsed(key, principal, now, Number(config.window_ms))
      if (integer(used + units) > Number(config.max_units)) fail('rate_limited', 'Sliding rate window is exhausted.')
      this.db.charge(2)
      this.db.database.prepare('INSERT INTO net_rate_charges VALUES(?,?,?,?,?)').run(key, principal, operationId, now, units)
      this.db.database.prepare('UPDATE net_rate_config SET last_now=? WHERE scope=? AND principal=?').run(now, key, principal)
    })
  }
  remainingRate(scope: StorageLimitScope, principal: string, now: number): number {
    const key = this.scope(scope); this.id(principal); integer(now)
    const config = this.db.database.prepare('SELECT * FROM net_rate_config WHERE scope=? AND principal=?').get(key, principal)
    if (!config) return 0
    if (now < Number(config.last_now)) fail('clock_skew', 'Rate clock moved backwards.')
    return Math.max(0, Number(config.max_units) - this.rateUsed(key, principal, now, Number(config.window_ms)))
  }
  private scope(scope: StorageLimitScope): string {
    if (scope.kind === 'space') { if (!isId('space', scope.space)) fail('bad_request', 'Invalid space quota scope.') }
    else if (scope.kind === 'profile') this.id(scope.profileId)
    else fail('bad_request', 'Unknown storage limit scope.')
    return json(scope)
  }
  private id(value: string): void { if (typeof value !== 'string' || !value || value.length > 256) fail('bad_request', 'Invalid accounting identity.') }
  private quotaUsed(scope: string): number { return integer(Number(this.db.database.prepare('SELECT coalesce(sum(units),0) AS n FROM net_quota_reservations WHERE scope=? AND released=0').get(scope)!.n)) }
  private rateUsed(scope: string, principal: string, now: number, window: number): number {
    // The half-open window (now-window, now] gives an exact expiry boundary.
    return integer(Number(this.db.database.prepare('SELECT coalesce(sum(units),0) AS n FROM net_rate_charges WHERE scope=? AND principal=? AND created_at>? AND created_at<=?').get(scope, principal, now - window, now)!.n))
  }
}

import { useEffect, useState } from 'react'
import type { ModelRouteOffer, ModelRouteView } from '../../../shared/harness/modelRoute'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { SettingsRow } from '../settings/SettingsRow'
import { errorText, useAsyncAction } from './parts'

/**
 * A Codex entry's model provider (docs/plans/codex-own-provider.md), in its Setup group. Nothing
 * shows while it runs on ChatGPT and config.toml selects nothing else. When config.toml selects a
 * provider with its own key, a row offers it ("Use it"); once agreed, a row names what the entry
 * bills and switches back to ChatGPT. The key is only ever masked.
 */

/** "api.example.com · key •••• 1a2b · billed to that key" */
export function routeDescription(route: { host: string; keyMasked?: string }): string {
  return [route.host, route.keyMasked ? `key ${route.keyMasked}` : undefined, 'billed to that key'].filter(Boolean).join(' · ')
}

function OfferRow({ offer, busy, failure, onUse }: { offer: ModelRouteOffer; busy: boolean; failure?: React.ReactNode; onUse: () => void }) {
  return (
    <SettingsRow
      title={`${offer.name} in config.toml`}
      description={failure ?? routeDescription(offer)}
      control={
        <button type="button" className="settings-btn" disabled={busy} onClick={onUse}>
          Use it
        </button>
      }
    />
  )
}

export function ModelRouteRows({ snapshot }: { snapshot: InstanceSnapshot }) {
  const instances = typeof window === 'undefined' ? undefined : window.mousse?.providers?.instances
  const supported = snapshot.driver === 'codex' && Boolean(instances?.modelRoute)
  const [view, setView] = useState<ModelRouteView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { busy, error, run } = useAsyncAction()
  const { instanceId } = snapshot
  // Read again whenever the entry was checked: the file may have changed with its sign-in.
  const checkedAt = snapshot.checkedAt
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    instances!.modelRoute(instanceId).then(
      (next) => { if (!cancelled) { setView(next); setLoadError(null) } },
      (failure: unknown) => { if (!cancelled) setLoadError(errorText(failure)) }
    )
    return () => { cancelled = true }
  }, [supported, instances, instanceId, checkedAt])

  if (!supported) return null
  if (loadError) return <SettingsRow title="Model provider" description={<span className="prov-error">{loadError}</span>} />
  if (!view) return null
  const choose = (route: { table: string; baseUrl: string } | null) =>
    void run(route ? 'use' : 'chatgpt', async () => setView(await instances!.setModelRoute({ instanceId, route })))
  const failure = error ? <span className="prov-error">{error}</span> : undefined

  if (view.kind === 'chatgpt') {
    if (view.offer) {
      const offer = view.offer
      return <OfferRow offer={offer} busy={busy !== null} failure={failure} onUse={() => choose({ table: offer.table, baseUrl: offer.baseUrl })} />
    }
    if (view.problem) return <SettingsRow title="Model provider in config.toml" description={<span className="prov-warning-text">{view.problem}</span>} />
    return null
  }

  const offer = view.offer
  return (
    <>
      <SettingsRow
        title={`Runs on ${view.name ?? view.table}`}
        description={failure ?? (view.problem ? <span className="prov-error">{view.problem}</span> : routeDescription(view))}
        control={
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => choose(null)}>
            Use ChatGPT
          </button>
        }
      />
      {offer && <OfferRow offer={offer} busy={busy !== null} onUse={() => choose({ table: offer.table, baseUrl: offer.baseUrl })} />}
    </>
  )
}

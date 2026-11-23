import { useEffect, useRef, useState } from 'react'
import type { BotModelPick, BotModelSlotKey } from '../../../shared/bots/personal/definition'
import type { BotShownRows } from '../../../shared/bots/personal/methods'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { isPinned } from '../../../shared/bots/personal/modelSlots'
import type { ProviderUsage } from '../../../shared/providerAuth'
import type { LlmProviderOption } from '../../../shared/settings'
import { shortModelName } from '../../../shared/modelNames'
import { Brain } from '../../lib/icons'
import { scaleMotionMs } from '../../lib/motion'
import { ProviderIcon } from '../../lib/providerIcons'
import { usageLevel } from '../../lib/subscriptionUsage'
import { botsClient, useBotsStore } from '../../stores/botsStore'
import { errorText } from '../../services/personalBotsClient'
import { SettingsModelPicker } from '../settings/SettingsModelPicker'
import { borrowedRow, borrowedRowTitle, botRowTitle, offeredListing, PICK_A_MODEL, sameAsLabel, severalEntries } from './BotRunsOn'
import { nextReading, usageReading, type BotUsageReading } from './botUsageRing'
import '../../styles/usage.css'

/**
 * The bot header's model button, beside the side-panel toggle: the logo of the provider the bot talks on, ringed by how
 * much of that provider's usage is left, and a menu of the bot's model rows (Talk, Light, Medium and Hard work), each the
 * app's model picker, saving as About → Runs on does.
 */

const ROWS: readonly { key: BotModelSlotKey; label: string; hint: string }[] = [
  { key: 'talk', label: 'Talk', hint: 'Every chat reply' },
  { key: 'light', label: 'Light work', hint: 'Quick lookups and small routine jobs' },
  { key: 'medium', label: 'Medium work', hint: 'Most work' },
  { key: 'hard', label: 'Hard work', hint: 'Research, and long or difficult problems' }
]

/** The pick the bot talks on: Talk's, else the row Talk runs on. */
export function talkPick(slots: BotShownRows): BotModelPick | null {
  if (isPinned(slots.talk)) return slots.talk
  const source = borrowedRow(slots, 'talk')
  return source ? slots[source] : null
}

/** How often a window that shows a ring asks the service to keep reading its provider (its lease is 7 minutes). */
const WATCH_ASK_MS = 4 * 60_000
/** How often the ring and tooltip look at the clock again: limits reset and readings age between readings. */
const CLOCK_MS = 60_000
/** How long the menu takes to fade out at Normal speed; keep in step with bots.css. */
const CLOSE_MS = 120

/**
 * The usage of the provider entry `instanceId`, from the readings the service keeps; it never reads a provider itself.
 * While the window is visible and the reading gives a ring (or there is none yet), it asks the service to read the
 * provider every 5 minutes (`providers.watchUsage`), and each reading kept reaches it as `providers.usage`.
 */
function useTalkUsage(instanceId: string | undefined, model: string): BotUsageReading {
  const [slotId, setSlotId] = useState<string | null>(null)
  const [usage, setUsage] = useState<ProviderUsage | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setSlotId(null)
    setUsage(undefined)
    if (!instanceId) return
    let live = true
    window.mousse.providers.usageSlots().then(({ slots }) => {
      const slot = slots.find((entry) => entry.instanceId === instanceId || entry.id === instanceId)
      if (!live || !slot) return
      setSlotId(slot.id)
      setUsage(slot.cached)
    }, () => undefined)
    return () => { live = false }
  }, [instanceId])
  useEffect(() => {
    if (!slotId) return
    return window.mousse.providers.onUsage((event) => { if (event.usage?.id === slotId) setUsage((shown) => nextReading(shown, event.usage)) })
  }, [slotId])
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') setNow(Date.now()) }
    const timer = window.setInterval(tick, CLOCK_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [])
  const reading = usageReading(usage, now, model)
  const watch = slotId !== null && (usage === undefined || reading.left !== undefined)
  useEffect(() => {
    if (!watch || !slotId) return
    let live = true
    const ask = () => {
      if (document.visibilityState !== 'visible') return
      window.mousse.providers.watchUsage(slotId).then((reply) => { if (live && reply.cached) setUsage((shown) => nextReading(shown, reply.cached!)) }, () => undefined)
    }
    ask()
    const timer = window.setInterval(ask, WATCH_ASK_MS)
    document.addEventListener('visibilitychange', ask)
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', ask) }
  }, [watch, slotId])
  return reading
}

const RING_SIZE = 30
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** A thin ring, filled clockwise from the top to the share left, in the usage level's colour over a faint track. */
function UsageRing({ left }: { left: number }) {
  const share = Math.max(0, Math.min(100, left)) / 100
  const centre = RING_SIZE / 2
  return <svg className="bot-model-ring" width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden data-usage-level={usageLevel(left)}>
    <circle className="bot-model-ring-track" cx={centre} cy={centre} r={RING_RADIUS} strokeWidth={RING_STROKE} />
    {share > 0 && <circle className="bot-model-ring-fill" cx={centre} cy={centre} r={RING_RADIUS} strokeWidth={RING_STROKE}
      strokeDasharray={`${RING_LENGTH * share} ${RING_LENGTH}`} transform={`rotate(-90 ${centre} ${centre})`} />}
  </svg>
}

export function BotModelButton({ bot }: { bot: BotSummary }) {
  const botId = bot.id
  const info = useBotsStore((state) => state.modelInfo[botId])
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // Mounted while it shows or fades out; `shown` turns on a frame after mounting so it fades in.
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // Read again when the bot has done something (it may have changed its rows with `use_model`), and on opening.
  const refresh = `${bot.last?.at ?? ''}|${bot.lastOutcome ?? ''}`
  useEffect(() => { void useBotsStore.getState().loadModelInfo(botId) }, [botId, refresh])
  useEffect(() => {
    if (open) {
      void useBotsStore.getState().loadModelInfo(botId)
      setMounted(true)
      const frame = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(frame)
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), scaleMotionMs(CLOSE_MS))
    return () => window.clearTimeout(timer)
  }, [open, botId])
  useEffect(() => {
    if (!open) return
    // A row's model menu floats in a layer of its own: a press there is not away.
    const away = (event: MouseEvent) => {
      const path = event.composedPath()
      if (root.current && !path.includes(root.current) && !path.some((node) => node instanceof Element && node.classList.contains('composer-model-picker-shell'))) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const providers = info?.providers ?? []
  const slots = info?.slots
  const talk = slots ? talkPick(slots) : null
  const listing = offeredListing(providers, talk)
  const { left, tooltip } = useTalkUsage(listing ? talk?.instanceId : undefined, talk?.model ?? '')
  // An older service without rows has nothing to show here.
  if (!info || !slots || !info.providers) return null

  const save = async (rows: Partial<BotShownRows>) => {
    const before = useBotsStore.getState().modelInfo[botId]
    setError(null)
    if (before?.slots) {
      const next = { ...before.slots, ...rows }
      useBotsStore.setState((state) => ({ modelInfo: { ...state.modelInfo, [botId]: { ...before, slots: next, model: next.talk?.model ?? null } } }))
    }
    try {
      await botsClient().setSlots(botId, { slots: rows })
    } catch (cause) {
      if (before) useBotsStore.setState((state) => ({ modelInfo: { ...state.modelInfo, [botId]: before } }))
      setError(errorText(cause))
    }
    void useBotsStore.getState().loadModelInfo(botId)
  }
  const entries = severalEntries(providers)
  const modelName = listing && talk ? shortModelName(talk.model) : PICK_A_MODEL
  return <div className="bot-model-root" ref={root} onKeyDown={(event) => {
    // A row's open model menu takes Escape first.
    if (event.key !== 'Escape' || !open || root.current?.querySelector('.settings-model-btn.open')) return
    event.stopPropagation()
    setOpen(false)
    button.current?.focus()
  }}>
    <button ref={button} type="button" className={`bot-header-model${open ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`${bot.name}'s models: talks on ${modelName}. ${tooltip}`} title={tooltip} onClick={() => setOpen(!open)}>
      {left !== undefined && <UsageRing left={left} />}
      {listing ? <ProviderIcon providerId={listing.id} size={15} /> : <Brain size={15} aria-hidden="true" />}
    </button>
    {mounted && <div className="bot-model-pop" role="dialog" aria-label={`${bot.name}'s models`} data-shown={shown} inert={!open || undefined}>
      {/* About's own rows, so the menu looks and reads as Runs on does. */}
      <div className="bot-model-picker"><div className="bot-model-rows">
        {ROWS.map((row) => {
          const pick = slots[row.key]
          const rowListing = offeredListing(providers, pick)
          const picked = rowListing && pick ? pick : null
          const source = borrowedRow(slots, row.key)
          return <div className="bot-model-row" key={row.key}>
            <span className="bot-model-row-label" title={row.hint}>{row.label}</span>
            <SettingsModelPicker
              ariaLabel={`${bot.name}'s ${row.label} model`}
              providers={providers as LlmProviderOption[]}
              unavailableProviders={info.unavailableProviders}
              providerId={rowListing?.id ?? ''}
              instanceId={picked?.instanceId}
              modelId={picked?.model ?? ''}
              effort={picked?.effort}
              placeholder={isPinned(pick) && !rowListing ? `${shortModelName(pick.model)} · not available` : source ? sameAsLabel(source) : PICK_A_MODEL}
              title={source ? borrowedRowTitle(providers, slots, source) : botRowTitle(providers, pick, info.named?.[row.key])}
              entry={entries && rowListing ? rowListing.label : undefined}
              // Every pick is sent, also the one the row has: saving it again accepts an entry whose sign-in changed.
              onSelect={(_providerId, choice, instanceId) => {
                if (instanceId) void save({ [row.key]: { instanceId, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}) } })
              }}
            />
          </div>
        })}
      </div></div>
      {error && <p className="bot-model-pop-error" role="alert">{error}</p>}
    </div>}
  </div>
}

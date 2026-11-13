import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Brain, Clock, Shield, X } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotMemoryEntry } from '../../../shared/bots/personal/memory'
import type { BotShownRows, BotsPersonalV2Result } from '../../../shared/bots/personal/methods'
import { botFaceState, botsClient, useBotsStore } from '../../stores/botsStore'
import { useAppStore } from '../../stores/appStore'
import { errorText } from '../../services/personalBotsClient'
import { BotComputerSelect, BotModelRows, BotModelSelect } from './BotRunsOn'
import { BotFace } from './face/BotFace'

/** About's Runs on section, which a bot's Pick a model scrolls to. */
export const RUNS_ON_ID = 'bot-about-runs-on'

/** "Mon 09:00" for a run's next time; today's runs show the time alone. */
export function nextRunText(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** When a reminder fires: like a run's next time within the week, else "14 Nov 09:00". */
export function reminderWhenText(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  if (date.getTime() - now.getTime() < 6 * 24 * 60 * 60_000) return nextRunText(at, now)
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * What a bot runs on, by hand (#673): its model rows (Talk and Work, and with Advanced each kind of work), each an
 * entry's model at a reasoning level picked in the app's model picker, and the computer it runs on (the one that holds
 * it; the person's other computers are listed, greyed, once there are two or more). A pick saves only its own rows,
 * over the rows as they are then, so a change the bot made meanwhile stays; the rows are read again when the bot posts a
 * message (a `use_model` turn ends with one) or its stuck line changes. An older service has no rows: one Model picker,
 * as before.
 */
function RunsOn({ botId, name, refresh }: { botId: string; name: string; refresh: string }) {
  const [choices, setChoices] = useState<BotsPersonalV2Result<'bots.model.get'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const client = botsClient()
  // Saves in flight: a read that answers meanwhile is older than what the owner sees.
  const saving = useRef(0)
  const read = useCallback(() => {
    let live = true
    client.model(botId).then((next) => { if (live && !saving.current) setChoices(next) }, (cause) => { if (live) setError(errorText(cause)) })
    return () => { live = false }
    // The client is a thin wrapper over the window's transport; the bot decides what to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId])
  // Read when About opens, and again after the bot's next message or a new stuck line (`use_model`, a pick that can't
  // run); each read checks every entry, so not on every status change.
  useEffect(read, [read, refresh])
  if (!choices) return error ? <p className="bot-about-empty" role="alert">{error}</p> : null
  const pick = async (model: string | null) => {
    setError(null)
    try {
      await client.setModel(botId, model)
      setChoices({ ...choices, model })
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const save = async (shown: BotShownRows, change: Parameters<typeof client.setSlots>[1]) => {
    const before = choices
    setError(null)
    setChoices({ ...choices, slots: shown, model: shown.talk?.model ?? null })
    saving.current += 1
    try {
      await client.setSlots(botId, change)
    } catch (cause) {
      setChoices(before)
      setError(errorText(cause))
    } finally {
      saving.current -= 1
    }
    read()
  }
  const slots = choices.slots
  return <>
    {slots && choices.providers
      ? <div id={RUNS_ON_ID}>
        <BotModelRows
          name={name}
          providers={choices.providers}
          slots={slots}
          {...(choices.named ? { named: choices.named } : {})}
          {...(choices.notes ? { notes: choices.notes } : {})}
          onPick={(rows, picked) => {
            const changed = Object.fromEntries(rows.map((row) => [row, picked])) as Partial<BotShownRows>
            void save({ ...slots, ...changed }, { slots: changed })
          }}
          onOneWork={() => void save({ ...slots, light: slots.medium, hard: slots.medium }, { oneWork: true })}
        />
      </div>
      : <div className="bot-about-row" data-testid="bot-about-model">
        <span>Model</span>
        <BotModelSelect ariaLabel={`${name}'s model`} models={choices.models} value={choices.model} onChange={(model) => void pick(model)} />
      </div>}
    {choices.computers.length > 1 ? (
      <div className="bot-about-row" data-testid="bot-about-computer">
        <span>Computer</span>
        <BotComputerSelect ariaLabel={`${name}'s computer`} title={`${name} runs on the computer that holds it`} choices={choices} />
      </div>
    ) : null}
    {error ? <p className="bot-about-empty" role="alert">{error}</p> : null}
  </>
}

/**
 * What the bot remembers: the entries every turn carries, each with Remove. Read again whenever the bot's detail
 * reloads (after each of its turns), so an entry it just saved shows up.
 */
function Memory({ botId, detail }: { botId: string; detail: unknown }) {
  const [entries, setEntries] = useState<BotMemoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const client = botsClient()
  useEffect(() => {
    let live = true
    client.memory(botId).then((listing) => { if (live) setEntries(listing.entries.filter((entry) => entry.status === 'active' && entry.text)) }, (cause) => { if (live) setError(errorText(cause)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, detail])
  const remove = async (entry: BotMemoryEntry) => {
    setError(null)
    try {
      await client.forgetMemory(botId, entry.id)
      setEntries((current) => current?.filter((item) => item.id !== entry.id) ?? null)
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  return <>
    {entries?.length
      ? entries.map((entry) => <div className="bot-about-row" key={entry.id} data-testid="bot-about-memory">
        <Brain size={14} aria-hidden /><span title={entry.text ?? undefined}><span className="bot-about-clamp">{entry.text}</span></span>
        <button type="button" aria-label={`Remove memory: ${entry.text}`} onClick={() => void remove(entry)}>Remove</button>
      </div>)
      : entries || !error ? <p className="bot-about-empty">{entries ? 'Nothing yet. Tell it what to remember.' : 'Loading…'}</p> : null}
    {error ? <p className="bot-about-empty" role="alert">{error}</p> : null}
  </>
}

/**
 * About this bot (bot-ui §4.8): the whole mouse, the name and the description; what it can use and
 * when it runs, each with Remove; what it remembers, each with Remove; what it runs on, by hand or by usage (#673); Pause and Delete.
 */
export function BotAboutPanel({ bot }: { bot: BotSummary }) {
  const detail = useBotsStore((s) => s.details[bot.id])
  const happy = useBotsStore((s) => s.happy[bot.id])
  useEffect(() => { void useBotsStore.getState().loadDetail(bot.id) }, [bot.id])
  const store = useBotsStore.getState
  const paused = bot.state === 'paused'
  return <aside className="bot-about" aria-label={`About ${bot.name}`}>
    <div className="bot-about-close"><button type="button" className="bot-close" aria-label="Close About" onClick={() => useBotsStore.setState({ aboutOpen: false })}><X size={14} /></button></div>
    <div className="bot-about-head">
      <BotFace look={bot.look} state={botFaceState(bot, happy)} size={88} view="full" />
      <h2>{bot.name}</h2>
      <p>{bot.description}</p>
    </div>
    <h3>CAN USE</h3>
    {detail?.permissions.length
      ? detail.permissions.map((item) => <div className="bot-about-row" key={item.id}>
        <Shield size={14} aria-hidden /><span title={item.note || undefined}>{item.title.charAt(0).toUpperCase() + item.title.slice(1)}{(item.mark || item.gone) && <small className="bot-about-next" data-testid="bot-about-gone">{item.mark ?? 'Gone from Mousse'}</small>}</span>
        <button type="button" aria-label={`Remove ${item.title}`} onClick={() => void store().revokePermission(bot.id, item.id)}>Remove</button>
      </div>)
      : <p className="bot-about-empty">{detail ? 'Nothing yet. It asks in the chat the first time it needs something.' : 'Loading…'}</p>}
    <h3>RUNS</h3>
    {detail?.reminders?.map((reminder) => <div className="bot-about-row" key={reminder.id} data-testid="bot-about-reminder">
      <Bell size={14} aria-hidden /><span title={reminder.text}><span className="bot-about-clamp">{reminder.text}</span><small className="bot-about-next">{reminder.work ? 'Starts' : 'Reminds'}: {reminderWhenText(reminder.dueAt)}</small></span>
      <button type="button" aria-label={`Cancel reminder: ${reminder.text}`} onClick={() => void store().cancelReminder(bot.id, reminder.id)}>Cancel</button>
    </div>)}
    {detail?.runs.length
      ? detail.runs.map((run) => <div className="bot-about-row" key={run.id}>
        <Clock size={14} aria-hidden /><span>{run.label.charAt(0).toUpperCase() + run.label.slice(1)}{run.nextAt && <small className="bot-about-next">Next: {nextRunText(run.nextAt)}</small>}</span>
        <button type="button" aria-label={`Remove ${run.label}`} onClick={() => void store().removeSchedule(bot.id, run.id)}>Remove</button>
      </div>)
      : null}
    {detail && !detail.runs.length && !detail.reminders?.length
      ? <p className="bot-about-empty">Only when you message it. Ask it to run on a schedule.</p>
      : null}
    {detail?.runs.length
      ? <button type="button" className="bot-ghost-button bot-about-automations" data-testid="bot-about-automations" title="Open them in Automations" onClick={() => useAppStore.getState().setScheduledOpen(true)}>
        {`Runs ${detail.runs.length} ${detail.runs.length === 1 ? 'automation' : 'automations'}`}
      </button>
      : null}
    <h3>MEMORY</h3>
    <Memory botId={bot.id} detail={detail} />
    <h3>RUNS ON</h3>
    <RunsOn botId={bot.id} name={bot.name} refresh={`${bot.last?.at ?? ''}|${bot.error?.text ?? ''}`} />
    <div className="bot-about-foot">
      <button type="button" className="bot-ghost-button" onClick={() => void (paused ? store().resume(bot.id) : store().pause(bot.id))}>{paused ? 'Resume' : 'Pause'}</button>
      <button type="button" className="bot-ghost-button is-danger" onClick={() => useBotsStore.setState({ dialog: { kind: 'delete', botId: bot.id }, error: null })}>Delete</button>
    </div>
  </aside>
}

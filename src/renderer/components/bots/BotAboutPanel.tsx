import { useEffect, useState } from 'react'
import { Clock, Shield, X } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import type { BotsPersonalV2Result } from '../../../shared/bots/personal/methods'
import { botFaceState, botsClient, useBotsStore } from '../../stores/botsStore'
import { errorText } from '../../services/personalBotsClient'
import { Select } from '../ui/Select'
import { BotFace } from './face/BotFace'

/** "Mon 09:00" for a run's next time; today's runs show the time alone. */
export function nextRunText(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/**
 * What a bot runs on, by hand (#673): By usage (the default) or a model, and the computer it runs on (this one, until
 * bots can run on your other computers).
 */
function RunsOn({ botId, name }: { botId: string; name: string }) {
  const [choices, setChoices] = useState<BotsPersonalV2Result<'bots.model.get'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const client = botsClient()
  useEffect(() => {
    let live = true
    client.model(botId).then((next) => { if (live) setChoices(next) }, (cause) => { if (live) setError(errorText(cause)) })
    return () => { live = false }
    // The client is a thin wrapper over the window's transport; the bot decides what to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId])
  if (!choices) return error ? <p className="bot-about-empty" role="alert">{error}</p> : null
  const pick = async (model: string) => {
    setError(null)
    try {
      await client.setModel(botId, model || null)
      setChoices({ ...choices, model: model || null })
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const models = [{ value: '', label: 'By usage' }, ...choices.models.map((choice) => ({ value: choice.model, label: choice.label }))]
  if (choices.model && !choices.models.some((choice) => choice.model === choices.model)) models.push({ value: choices.model, label: `${choices.model} (not available now)` })
  return <>
    <div className="bot-about-row" data-testid="bot-about-model">
      <span>Model</span>
      <Select ariaLabel={`${name}'s model`} size="small" value={choices.model ?? ''} options={models} title="By usage picks a ready model each run" onChange={(model) => void pick(model)} />
    </div>
    <div className="bot-about-row" data-testid="bot-about-computer">
      <span>Computer</span>
      <Select ariaLabel={`${name}'s computer`} size="small" value={choices.computer} options={choices.computers.map((computer) => ({ value: computer.id, label: computer.name }))} title="Your other computers join this list later" onChange={() => undefined} />
    </div>
    {error ? <p className="bot-about-empty" role="alert">{error}</p> : null}
  </>
}

/**
 * About this bot (bot-ui §4.8): the whole mouse, the name and the description; what it can use and
 * when it runs, each with Remove; what it runs on, by hand or by usage (#673); Pause and Delete.
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
        <Shield size={14} aria-hidden /><span title={item.note || undefined}>{item.title.charAt(0).toUpperCase() + item.title.slice(1)}</span>
        <button type="button" aria-label={`Remove ${item.title}`} onClick={() => void store().revokePermission(bot.id, item.id)}>Remove</button>
      </div>)
      : <p className="bot-about-empty">{detail ? 'Nothing yet. It asks in the chat the first time it needs something.' : 'Loading…'}</p>}
    <h3>RUNS</h3>
    {detail?.runs.length
      ? detail.runs.map((run) => <div className="bot-about-row" key={run.id}>
        <Clock size={14} aria-hidden /><span>{run.label.charAt(0).toUpperCase() + run.label.slice(1)}{run.nextAt && <small className="bot-about-next">Next: {nextRunText(run.nextAt)}</small>}</span>
        <button type="button" aria-label={`Remove ${run.label}`} onClick={() => void store().removeSchedule(bot.id, run.id)}>Remove</button>
      </div>)
      : detail && <p className="bot-about-empty">Only when you message it. Ask it to run on a schedule.</p>}
    <h3>RUNS ON</h3>
    <RunsOn botId={bot.id} name={bot.name} />
    <div className="bot-about-foot">
      <button type="button" className="bot-ghost-button" onClick={() => void (paused ? store().resume(bot.id) : store().pause(bot.id))}>{paused ? 'Resume' : 'Pause'}</button>
      <button type="button" className="bot-ghost-button is-danger" onClick={() => useBotsStore.setState({ dialog: { kind: 'delete', botId: bot.id }, error: null })}>Delete</button>
    </div>
  </aside>
}

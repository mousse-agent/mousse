import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BOT_IMAGES_PER_DAY, BOT_IMAGES_PER_TURN, MAX_BOT_IMAGE_BYTES, MAX_BOT_IMAGE_PROMPT_CHARS, type BotModelPick, type BotPickCredential } from '../../../shared/bots/personal/definition'
import type { BotImageUsage } from '../../../shared/bots/personal/methods'
import { pickReasonText, plainLabel, type BotPickReason } from '../../../shared/bots/personal/modelSlots'
import type { CounterScope } from '../../../shared/harness/counters'
import type { SpendScope } from '../../../shared/harness/spend'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import { ImageRequestError, type GeneratedImage, type ImageFailureKind, type ImageModelFacts, type ImageRequestSpec } from '../../harness/driver'
import { accountOf, instanceReady } from '../model/candidates'
import { dayOf, imageFileStem, imageTypeOf, saveBotPicture } from './pictures'

export { imageFileStem, imageTypeOf, saveBotPicture } from './pictures'

/**
 * A bot's pictures (#1088): `make_image` asks this service, which makes the picture on the model the owner picked in
 * Runs on's Images row, through Mousse's own provider code (`HarnessGateway.generateImage`), never through a runtime's
 * own image tool. The pick is the consent: with no pick there is nothing to make. A pick that is not offered now is
 * refused and nothing is made on another model. Every request sent counts against the bot's caps (a day, and one chat
 * turn or one piece of work), kept in `<profile>/bots/images.json`, outside the bot's files folder, so a continued or
 * restarted turn does not start over. The picture is saved in the bot's files folder under `images/<date>/`, and
 * nowhere else.
 */

/** One model the Images row can be given: an entry's image model, with what the entry is signed in with now. */
export interface BotImageOption {
  instanceId: string
  entry: string
  model: string
  label: string
  price: { input: number; output: number }
  credential?: BotPickCredential
  account?: string
}

export interface BotImageMakerDeps {
  /** `<profile>/bots`: the caps' ledger is kept here, where no bot writes. */
  dir: string
  /** The bot's files folder (`botFilesFolder`). */
  filesFolder(botId: string): string
  /** The Images row now, from the bot's published definition; null: none. */
  pick(botId: string): (BotModelPick & { instanceId: string }) | null
  /** Provider snapshots in the device scope. */
  snapshots(): Promise<readonly InstanceSnapshot[]>
  /** An entry's image models (`HarnessGateway.imageModels`). */
  imageModels(instanceId: string): readonly ImageModelFacts[]
  /** One picture (`HarnessGateway.generateImage`). */
  generate(request: ImageRequestSpec & { instanceId: string; signal: AbortSignal }): Promise<GeneratedImage>
  now?(): Date
  /** Where a provider's own words go: the log, never the bot or the chat. */
  log?(message: string, details: Record<string, unknown>): void
}

/** What `make_image` hands back: the saved picture, or one fixed line the bot passes on. */
export type BotImageResult =
  | { ok: true; path: string; name: string; markdown: string; text?: string; today: number }
  | { ok: false; text: string }

/** The bot's line when its owner picked no image model. */
export const NO_IMAGE_MODEL_TEXT = "Your owner hasn't picked an image model for you, so you can't make pictures. Tell them they can pick one in About → Runs on, in the Images row."

const NOTHING_MADE = 'Nothing was made.'

/** The fixed line for each way a request made no picture; the provider's own words go to the log only. */
const FAILURE_TEXT: Record<ImageFailureKind | 'too_large' | 'not_image' | 'stopped', string> = {
  refused: 'The image model refused this request. You may describe it differently, or tell your owner.',
  signed_out: "The image model's entry isn't signed in, or its key was refused. Tell your owner to check it in Settings → Providers.",
  no_credit: "The image model's account has no credit left. Tell your owner.",
  busy: 'The image model is busy or at its limit right now. Try again later.',
  no_answer: "The image model didn't answer. Try again later.",
  no_image: 'The image model sent no picture. You may describe it differently.',
  failed: "The image model couldn't make this picture.",
  too_large: `The picture was larger than ${MAX_BOT_IMAGE_BYTES / 1024 / 1024} MB, so it wasn't saved.`,
  not_image: "The image model sent something that isn't a PNG, JPEG, WebP or GIF picture, so it wasn't saved.",
  stopped: 'Stopped before the picture was made.'
}

/** The fixed line for a failure kind, with "Nothing was made." */
export function imageFailureText(kind: keyof typeof FAILURE_TEXT): string {
  return `${FAILURE_TEXT[kind]} ${NOTHING_MADE}`
}

/** Output tokens one picture may be billed at most, for a spend reservation (a large picture is a few thousand). */
const IMAGE_OUTPUT_TOKENS = 16_000

interface Ledger {
  v: 1
  bots: Record<string, { days: Record<string, number>; turns: Record<string, { n: number; at: string }> }>
}

/** How long the ledger keeps a day's and a turn's counts. */
const KEEP_DAYS = 3

export class BotImageMaker {
  private ledger: Ledger | undefined

  constructor(private readonly deps: BotImageMakerDeps) {}

  /** Every ready entry's image models, as the Images row offers them (the same model on two entries is two options). */
  async options(): Promise<BotImageOption[]> {
    const snapshots = await this.deps.snapshots()
    return this.optionsOf(snapshots)
  }

  private optionsOf(snapshots: readonly InstanceSnapshot[]): BotImageOption[] {
    const options: BotImageOption[] = []
    for (const snapshot of snapshots) {
      if (!instanceReady(snapshot)) continue
      let models: readonly ImageModelFacts[] = []
      try {
        models = this.deps.imageModels(snapshot.instanceId)
      } catch {
        continue
      }
      const credential = snapshot.auth.credential && snapshot.auth.credential !== 'unknown' ? snapshot.auth.credential : undefined
      const account = accountOf(snapshot)
      for (const model of models) options.push({
        instanceId: snapshot.instanceId,
        entry: snapshot.displayName || snapshot.instanceId,
        model: model.id,
        label: model.label || model.id,
        price: model.price,
        ...(credential ? { credential } : {}),
        ...(account ? { account } : {})
      })
    }
    return options
  }

  /** Why a pick is not among the options now: its entry is gone, off, signed out or not ready, or it no longer offers the model. */
  private reasonOf(pick: BotModelPick & { instanceId: string }, snapshots: readonly InstanceSnapshot[]): BotPickReason {
    const snapshot = snapshots.find((entry) => entry.instanceId === pick.instanceId)
    if (!snapshot) return 'removed'
    if (!snapshot.enabled.effective) return 'off'
    if (snapshot.auth.state === 'signed_out' || snapshot.auth.state === 'expired') return 'signed_out'
    if (!instanceReady(snapshot)) return 'not_ready'
    return 'model_gone'
  }

  /** Today's pictures of a bot against its caps (About → Runs on, the Images row's tooltip). */
  usage(botId: string): BotImageUsage {
    const day = dayOf(this.now())
    return { today: this.read().bots[botId]?.days[day] ?? 0, perDay: BOT_IMAGES_PER_DAY, perTurn: BOT_IMAGES_PER_TURN }
  }

  /**
   * One picture for `botId`'s activation: on the Images row's pick or not at all, within the caps, counted as one
   * request on the activation's counters and charged to its spend (when it has a token or USD limit), saved in the
   * bot's files folder. Any refusal or failure is one fixed line and saves nothing.
   */
  async make(input: { botId: string; activationId: string; prompt: string; shape?: ImageRequestSpec['shape']; counters?: CounterScope; spend?: SpendScope | null; signal: AbortSignal }): Promise<BotImageResult> {
    const prompt = input.prompt.trim().slice(0, MAX_BOT_IMAGE_PROMPT_CHARS)
    if (!prompt) return { ok: false, text: 'make_image needs a description of the picture.' }
    const pick = this.deps.pick(input.botId)
    if (!pick) return { ok: false, text: NO_IMAGE_MODEL_TEXT }
    const snapshots = await this.deps.snapshots()
    const option = this.optionsOf(snapshots).find((entry) => entry.instanceId === pick.instanceId && entry.model === pick.model)
    const changed = option && pick.credential && option.credential && pick.credential !== option.credential ? 'sign_in_changed'
      : option && pick.account && option.account && pick.account !== option.account ? 'account_changed' : undefined
    if (!option || changed) {
      const reason = changed ?? this.reasonOf(pick, snapshots)
      return { ok: false, text: `Your owner's image model can't be used now: ${pickReasonText(reason)}. ${NOTHING_MADE} Tell them they can pick another one in About → Runs on.` }
    }
    // The caps, checked first and counted once the request is about to be sent: a request that fails still counts.
    const capped = this.capReached(input.botId, input.activationId)
    if (capped) return { ok: false, text: capped }
    const counted = input.counters?.charge('request')
    if (counted && !counted.ok) return { ok: false, text: `This turn reached its limit of ${counted.limit} model requests. ${NOTHING_MADE}` }
    let reservation: string | undefined
    if (input.spend) {
      const reserved = input.spend.reserve({ inputBound: Math.ceil(prompt.length / 2) + 64, wireCap: IMAGE_OUTPUT_TOKENS, floor: IMAGE_OUTPUT_TOKENS, price: option.price }, {})
      if (!reserved.ok) return { ok: false, text: `This turn has too little of its spending limit left for a picture. ${NOTHING_MADE}` }
      reservation = reserved.id
    }
    this.count(input.botId, input.activationId)
    const settle = (outcome: Parameters<SpendScope['settle']>[1]) => {
      if (reservation) input.spend?.settle(reservation, outcome)
    }
    let image: GeneratedImage
    try {
      image = await this.deps.generate({ instanceId: option.instanceId, model: option.model, prompt, ...(input.shape ? { shape: input.shape } : {}), signal: input.signal })
    } catch (error) {
      if (input.signal.aborted) {
        settle({ kind: 'used', input: 0, output: 0, usd: 0, partial: true })
        return { ok: false, text: imageFailureText('stopped') }
      }
      if (error instanceof ImageRequestError) {
        this.deps.log?.('[bots] an image request made no picture', { botId: input.botId, instanceId: option.instanceId, model: option.model, kind: error.kind, detail: error.detail.slice(0, 2000) })
        // A request the provider turned away before making anything is not billed; any other may have been.
        settle(error.kind === 'refused' || error.kind === 'signed_out' || error.kind === 'no_credit' || error.kind === 'busy' ? { kind: 'released' } : { kind: 'used', input: 0, output: 0, usd: 0, partial: true })
        return { ok: false, text: imageFailureText(error.kind) }
      }
      settle({ kind: 'released' })
      this.deps.log?.('[bots] an image request could not be sent', { botId: input.botId, instanceId: option.instanceId, model: option.model, detail: error instanceof Error ? error.message : String(error) })
      return { ok: false, text: `Your owner's image model can't be used now. ${NOTHING_MADE} Tell them they can check it in About → Runs on.` }
    }
    settle({ kind: 'used', input: image.usage?.input ?? 0, output: image.usage?.output ?? 0, usd: image.usage?.usd ?? 0 })
    const bytes = Buffer.from(image.data, 'base64')
    if (bytes.length > MAX_BOT_IMAGE_BYTES) return { ok: false, text: imageFailureText('too_large') }
    const type = imageTypeOf(bytes)
    if (!type) return { ok: false, text: imageFailureText('not_image') }
    let path: string
    try {
      path = this.save(input.botId, prompt, type, bytes)
    } catch (error) {
      this.deps.log?.('[bots] a picture could not be saved', { botId: input.botId, detail: error instanceof Error ? error.message : String(error) })
      return { ok: false, text: `The picture couldn't be saved in your files folder. ${NOTHING_MADE}` }
    }
    const name = basename(path)
    const alt = plainLabel(prompt, 80).replace(/[[\]]/g, '')
    return {
      ok: true,
      path,
      name,
      markdown: `![${alt}](${pathToFileURL(path).href})`,
      ...(image.text ? { text: plainLabel(image.text, 300) } : {}),
      today: this.usage(input.botId).today
    }
  }

  /** Saves the picture in the bot's files folder (`saveBotPicture`). */
  private save(botId: string, prompt: string, type: string, bytes: Buffer): string {
    return saveBotPicture(this.deps.filesFolder(botId), imageFileStem(prompt), type, bytes, this.now())
  }

  /** Which cap a bot's next request would pass, in the bot's words; undefined while neither is reached. */
  private capReached(botId: string, activationId: string): string | undefined {
    const bot = this.read().bots[botId]
    if ((bot?.days[dayOf(this.now())] ?? 0) >= BOT_IMAGES_PER_DAY) return `You've made ${BOT_IMAGES_PER_DAY} pictures today, the most a bot makes in a day. ${NOTHING_MADE} Tell your owner you can make more tomorrow.`
    if ((bot?.turns[activationId]?.n ?? 0) >= BOT_IMAGES_PER_TURN) return `You've made ${BOT_IMAGES_PER_TURN} pictures here, the most for one chat turn or one piece of work. ${NOTHING_MADE}`
    return undefined
  }

  /** Counts one request against the caps, in the ledger before it is sent (no await between the check and this). */
  private count(botId: string, activationId: string): void {
    const ledger = this.read()
    const now = this.now()
    const day = dayOf(now)
    const bot = ledger.bots[botId] ?? { days: {}, turns: {} }
    bot.days[day] = (bot.days[day] ?? 0) + 1
    bot.turns[activationId] = { n: (bot.turns[activationId]?.n ?? 0) + 1, at: now.toISOString() }
    ledger.bots[botId] = bot
    this.write(prune(ledger, now))
  }

  private path(): string {
    return join(this.deps.dir, 'images.json')
  }

  private read(): Ledger {
    if (this.ledger) return this.ledger
    let ledger: Ledger = { v: 1, bots: {} }
    try {
      if (existsSync(this.path())) {
        const parsed = JSON.parse(readFileSync(this.path(), 'utf8')) as Partial<Ledger>
        if (parsed?.v === 1 && parsed.bots && typeof parsed.bots === 'object') ledger = parsed as Ledger
      }
    } catch {
      // An unreadable ledger starts again: the caps count from now.
    }
    this.ledger = ledger
    return ledger
  }

  /** Written whole, through a temporary file renamed over it, before the request is sent. */
  private write(ledger: Ledger): void {
    this.ledger = ledger
    mkdirSync(this.deps.dir, { recursive: true })
    const temp = `${this.path()}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(ledger))
    renameSync(temp, this.path())
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }
}

/** Days and turns older than `KEEP_DAYS` dropped, and bots with nothing left. */
function prune(ledger: Ledger, now: Date): Ledger {
  const oldest = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60_000)
  const oldestDay = dayOf(oldest)
  for (const [botId, bot] of Object.entries(ledger.bots)) {
    for (const day of Object.keys(bot.days)) if (day < oldestDay) delete bot.days[day]
    for (const [id, turn] of Object.entries(bot.turns)) if (Date.parse(turn.at) < oldest.getTime()) delete bot.turns[id]
    if (!Object.keys(bot.days).length && !Object.keys(bot.turns).length) delete ledger.bots[botId]
  }
  return ledger
}

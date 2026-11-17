/**
 * A bot makes pictures on the model its owner picked in Runs on's Images row (#1088). The row is the consent: with a
 * pick the turn holds `make_image` (listed, offered and allowed); without one it holds none on any runtime, and a call
 * that gets through anyway makes nothing. A pick that is gone is refused and nothing is made elsewhere. The picture is
 * made by Mousse on the picked entry and model, saved in the bot's files folder only, and shown in the chat through the
 * markdown line the bot is given. The caps hold across a continued turn and a restart, and a provider's failure gives a
 * fixed line with its own words in the log only. Older builds keep the row while the rows are live.
 *
 * Inputs listed, as the cases below:
 * - Images row: picked; None; picked then removed mid-turn; picked on a model the entry no longer offers; picked on an
 *   entry that now signs in another way.
 * - Lanes: a chat turn, a piece of work, a consult (never).
 * - Caps: per activation (4), across a new maker on the same profile (a restart), per day (20).
 * - Provider: a picture; each failure kind; something that isn't a picture; a picture over 8 MB.
 * - Files folder: as Mousse made it; `images` a link out of it.
 * - Storage: a picked bot, a bot from before picks, an older build's rewrite of `main.model`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotChatService, imageProviderOptions } from '../../src/mms/bots/chat/BotChatService'
import { BotImageMaker, imageFailureText, NO_IMAGE_MODEL_TEXT } from '../../src/mms/bots/images/BotImageMaker'
import { botInstructions, botAllowedOf } from '../../src/mms/bots/instructions'
import { botFilesFolder } from '../../src/mms/bots/grants/compile'
import { ImageRequestError, type GeneratedImage, type ImageRequestSpec } from '../../src/mms/harness/driver'
import { failureKind, piImageModels, runPiImage, type PiImageModels } from '../../src/mms/harness/drivers/pi/images'
import { createAppToolRegistry } from '../../src/mms/run/mcp/appTools'
import { botTools, type BotAppToolDeps } from '../../src/mms/run/mcp/appTools/bots'
import type { MousseTool, ToolCallContext } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import { BOT_IMAGES_PER_DAY, BOT_IMAGES_PER_TURN, type BotModelSlots, type BotThreadSpec } from '../../src/shared/bots/personal/definition'
import { imagePickOf, modelSlotsProblem, slotsOf, withImagePick, withSlots } from '../../src/shared/bots/personal/modelSlots'
import { starterManifest } from '../../src/mms/bots/chat/projection'
import { rollUpChips } from '../../src/shared/bots/personal/chips'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { botImageSource } from '../../src/renderer/components/bots/imageSources'
import { markdownImages } from '../../src/renderer/chat/components/agent-elements/image-sources'
import { fakeAppToolHost } from '../run/appToolsFixture'
import { botFixture, createBot, start, type BotFixture } from './botFixture'

/** A 1×1 PNG, as an image model sends one (base64). */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const TALK = { instanceId: 'claude', model: 'sonnet', credential: 'subscription' as const }
const ROWS: BotModelSlots = { talk: TALK, light: TALK, medium: TALK, hard: TALK }
const FLASH = { instanceId: 'pi:openrouter', model: 'google/gemini-3.1-flash-image' }

/** The owner's entries: Claude Code (no image models) and an OpenRouter key with two image models. */
function snapshot(instanceId: string, displayName: string, credential: 'subscription' | 'api_key', options: { enabled?: boolean } = {}): InstanceSnapshot {
  return {
    instanceId, displayName, driver: instanceId.startsWith('pi:') ? 'pi' : 'claudeCode',
    enabled: { effective: options.enabled ?? true },
    auth: { state: 'signed_in', credential },
    runs: { state: 'yes' }
  } as unknown as InstanceSnapshot
}

interface Provider {
  snapshots: InstanceSnapshot[]
  models: Record<string, Array<{ id: string; label: string }>>
  calls: Array<ImageRequestSpec & { instanceId: string }>
  answer: () => Promise<GeneratedImage>
  logs: Array<Record<string, unknown>>
}

function provider(): Provider {
  return {
    snapshots: [snapshot('claude', 'Claude Code', 'subscription'), snapshot('pi:openrouter', 'OpenRouter', 'api_key')],
    models: { 'pi:openrouter': [{ id: FLASH.model, label: 'Gemini 3.1 Flash Image' }, { id: 'openai/gpt-image-2', label: 'GPT Image 2' }] },
    calls: [],
    answer: async () => ({ mimeType: 'image/png', data: PNG, usage: { input: 10, output: 1290, usd: 0.004 } }),
    logs: []
  }
}

function maker(f: BotFixture, p: Provider): BotImageMaker {
  return new BotImageMaker({
    dir: f.store.directory,
    filesFolder: (botId) => botFilesFolder(f.profile, botId),
    pick: (botId) => f.bots.imagePick(botId),
    snapshots: async () => p.snapshots,
    imageModels: (instanceId) => (p.models[instanceId] ?? []).map((model) => ({ ...model, price: { input: 0, output: 0 } })),
    generate: async ({ signal: _signal, ...request }) => {
      p.calls.push(request)
      return p.answer()
    },
    now: () => new Date(f.clock.now),
    log: (_message, details) => { p.logs.push(details) }
  })
}

const imagesOf = (folder: string): string[] => {
  const root = join(folder, 'images')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

describe('a bot\'s pictures', () => {
  let f: BotFixture
  let p: Provider
  let images: BotImageMaker
  let tools: Map<string, MousseTool>
  let deps: BotAppToolDeps
  let botId: string

  beforeEach(async () => {
    f = botFixture()
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Draw things for me.', reply: 'Hello.' })).botId
    f.bots.setOwnerSlots(botId, ROWS)
    p = provider()
    images = maker(f, p)
    deps = { host: f.bots.tools, images }
    tools = new Map(botTools(() => deps).map((tool) => [tool.name, tool]))
  })

  afterEach(() => f.close())

  /** The owner's message, and its chat turn started. */
  async function chat(text: string, id: string) {
    await f.bots.service.chatSend({ botId, text, clientRequestId: id })
    const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
    return { activation, ...(await start(f, activation.id)) }
  }

  /** A `make_image` call from the turn, as the bot makes it, with the turn's own authority. */
  async function make(authority: BotAuthority, args: Record<string, unknown>) {
    const threadId = f.store.dispatch(authority.activationId, 1)!.threadId!
    const ctx = {
      caller: { threadId, runId: 'r1', provider: 'pi', modeCeiling: 'default', accessLevel: 'lineage' },
      turn: { threadId, bot: authority } as ToolCallContext['turn'],
      toolCallId: `call-${Math.random().toString(16).slice(2)}`,
      signal: new AbortController().signal
    } as ToolCallContext
    const result = await tools.get('make_image')!.handler(args, ctx)
    return { ...result, value: result.isError ? undefined : JSON.parse(result.text) as Record<string, string> }
  }

  /** What a runtime is shown of `make_image` for this turn: its tool list (Claude Code, Codex) and per-turn offer (Pi). */
  function shown(authority: BotAuthority) {
    const { registry } = createAppToolRegistry({ host: fakeAppToolHost().host, bots: () => deps })
    const listed = registry.listFor({ readOnly: false, modeCeiling: 'default', botRole: 'activation', botTurnTools: authority.appTools }).some((tool) => tool.name === 'make_image')
    const offered = tools.get('make_image')!.offered!({ threadId: 't', bot: authority } as ToolCallContext['turn'])
    return { listed, offered, allowed: authority.check({ kind: 'app', tool: 'make_image', args: {} }).ok }
  }

  it('with a pick, makes the picture on that model, saves it in the files folder and gives the line the chat shows', async () => {
    f.bots.setImagePick(botId, FLASH)
    const turn = await chat('Draw me a red fox in the snow', 'm1')
    expect(shown(turn.prepared.authority)).toEqual({ listed: true, offered: true, allowed: true })
    const made = await make(turn.prepared.authority, { description: 'A red fox in the snow, watercolour', shape: 'landscape' })
    expect(made.isError).toBeFalsy()
    // Mousse called the picked entry and model, with the description and shape.
    expect(p.calls).toEqual([{ instanceId: 'pi:openrouter', model: FLASH.model, prompt: 'A red fox in the snow, watercolour', shape: 'landscape' }])
    // In the bot's files folder, under images/<date>/, as the picture's bytes.
    const files = botFilesFolder(f.profile, botId)
    expect(imagesOf(files)).toEqual([made.value!.path])
    expect(made.value!.path.startsWith(join(files, 'images', '2026-11-'))).toBe(true)
    expect(made.value!.saved).toMatch(/^a-red-fox-in-the-snow-watercolour-\d{6}\.png$/)
    expect(readFileSync(made.value!.path).equals(Buffer.from(PNG, 'base64'))).toBe(true)
    // The line the bot puts in its reply is one the chat shows as that file.
    const [image] = markdownImages(`Here it is:\n\n${made.value!.show}`)
    const source = botImageSource(image!.src)
    expect(source.kind === 'file' && resolve(source.path)).toBe(made.value!.path)
    expect(fileURLToPath(image!.src)).toBe(made.value!.path)
    // Counted as one model request of the turn, and in today's pictures.
    expect(images.usage(botId).today).toBe(1)
  })

  it('in work too', async () => {
    f.bots.setImagePick(botId, FLASH)
    const turn = await chat('Make a poster in the background', 'm1')
    const started = await f.bots.tools.work.start(botId, turn.activation.id, { title: 'Poster', brief: 'Make a poster of a fox.', key: 'k1' })
    const work = await start(f, started.workId)
    expect(shown(work.prepared.authority).listed).toBe(true)
    expect((await make(work.prepared.authority, { description: 'A poster of a fox' })).isError).toBeFalsy()
    expect(p.calls).toHaveLength(1)
  })

  it('without a pick there is no tool on any runtime, and a call that gets through makes nothing', async () => {
    const turn = await chat('Draw me a fox', 'm1')
    expect(shown(turn.prepared.authority)).toEqual({ listed: false, offered: false, allowed: false })
    const made = await make(turn.prepared.authority, { description: 'A fox' })
    expect(made).toMatchObject({ isError: true, text: NO_IMAGE_MODEL_TEXT })
    expect(p.calls).toEqual([])
    expect(imagesOf(botFilesFolder(f.profile, botId))).toEqual([])
    // The instructions say nothing about pictures as allowed; the base text says where to pick one.
    const text = botInstructions({ name: 'Pip', description: 'x', lane: 'chat', allowed: botAllowedOf(starterManifest()) })
    expect(text).not.toMatch(/Make pictures: yes/)
    expect(text).toMatch(/About → Runs on, in the Images row/)
    expect(botInstructions({ name: 'Pip', description: 'x', lane: 'chat', allowed: { ...botAllowedOf(starterManifest()), images: true } })).toMatch(/Make pictures: yes, with make_image/)
  })

  it('a pick removed while the turn runs is refused at the call; the next turn has no tool', async () => {
    f.bots.setImagePick(botId, FLASH)
    const turn = await chat('Draw me a fox', 'm1')
    f.bots.setImagePick(botId, null)
    expect(await make(turn.prepared.authority, { description: 'A fox' })).toMatchObject({ isError: true, text: NO_IMAGE_MODEL_TEXT })
    expect(p.calls).toEqual([])
  })

  it('a pick no longer offered, or on an entry that signs in another way now, is refused and nothing is made elsewhere', async () => {
    f.bots.setImagePick(botId, { ...FLASH, credential: 'api_key' })
    const turn = await chat('Draw me a fox', 'm1')
    p.models['pi:openrouter'] = [{ id: 'openai/gpt-image-2', label: 'GPT Image 2' }]
    expect(await make(turn.prepared.authority, { description: 'A fox' })).toMatchObject({ isError: true, text: expect.stringMatching(/^Your owner's image model can't be used now: it no longer offers that model\. Nothing was made\./) })
    p.models['pi:openrouter'] = [{ id: FLASH.model, label: 'Gemini 3.1 Flash Image' }]
    p.snapshots[1] = snapshot('pi:openrouter', 'OpenRouter', 'subscription')
    expect(await make(turn.prepared.authority, { description: 'A fox' })).toMatchObject({ isError: true, text: expect.stringMatching(/it signs in another way now/) })
    p.snapshots[1] = snapshot('pi:openrouter', 'OpenRouter', 'api_key', { enabled: false })
    expect(await make(turn.prepared.authority, { description: 'A fox' })).toMatchObject({ isError: true, text: expect.stringMatching(/it's turned off/) })
    expect(p.calls).toEqual([])
    expect(imagesOf(botFilesFolder(f.profile, botId))).toEqual([])
  })

  it('the caps hold across a continued turn and a restart, and per day', async () => {
    f.bots.setImagePick(botId, FLASH)
    const turn = await chat('Draw four foxes', 'm1')
    for (let n = 0; n < BOT_IMAGES_PER_TURN; n += 1) expect((await make(turn.prepared.authority, { description: `Fox ${n}` })).isError).toBeFalsy()
    // A new maker on the same profile (the service restarted): the turn's count is still there.
    deps = { host: f.bots.tools, images: maker(f, p) }
    tools = new Map(botTools(() => deps).map((tool) => [tool.name, tool]))
    expect(await make(turn.prepared.authority, { description: 'Fox 5' })).toMatchObject({ isError: true, text: expect.stringMatching(/You've made 4 pictures here/) })
    expect(p.calls).toHaveLength(BOT_IMAGES_PER_TURN)
    // The day's cap across activations; a failed request counts too.
    p.answer = async () => { throw new ImageRequestError('busy', '429 Too many requests') }
    const day = maker(f, p)
    for (let n = BOT_IMAGES_PER_TURN; n < BOT_IMAGES_PER_DAY; n += 1)
      await day.make({ botId, activationId: `act-${n}`, prompt: `Fox ${n}`, signal: new AbortController().signal })
    expect(await day.make({ botId, activationId: 'act-last', prompt: 'One more', signal: new AbortController().signal })).toMatchObject({ ok: false, text: expect.stringMatching(/You've made 20 pictures today/) })
    expect(p.calls).toHaveLength(BOT_IMAGES_PER_DAY)
    // The next day counts again.
    f.clock.now += 24 * 60 * 60_000
    expect(day.usage(botId).today).toBe(0)
  })

  it('a provider failure gives the fixed line for its kind; the provider\'s own words go to the log only', async () => {
    f.bots.setImagePick(botId, FLASH)
    const turn = await chat('Draw me a fox', 'm1')
    const raw = '402: {"error":{"message":"Insufficient credits for account acct_secret_123"}}'
    p.answer = async () => { throw new ImageRequestError(failureKind(raw), raw) }
    const made = await make(turn.prepared.authority, { description: 'A fox' })
    expect(made).toMatchObject({ isError: true, text: imageFailureText('no_credit') })
    expect(made.text).not.toMatch(/acct_secret_123|Insufficient/)
    expect(p.logs).toEqual([expect.objectContaining({ kind: 'no_credit', detail: raw })])
    // Something that isn't a picture is not saved.
    p.answer = async () => ({ mimeType: 'image/png', data: Buffer.from('<svg onload="x()"/>').toString('base64') })
    expect(await make(turn.prepared.authority, { description: 'A fox' })).toMatchObject({ isError: true, text: imageFailureText('not_image') })
    expect(imagesOf(botFilesFolder(f.profile, botId))).toEqual([])
  })

  it('writes nothing outside the bot\'s files folder, also when its images folder is a link out of it', async () => {
    f.bots.setImagePick(botId, FLASH)
    const turn = await chat('Draw me a fox', 'm1')
    const files = botFilesFolder(f.profile, botId)
    const outside = join(f.base, 'outside')
    mkdirSync(outside, { recursive: true })
    mkdirSync(files, { recursive: true })
    symlinkSync(outside, join(files, 'images'), process.platform === 'win32' ? 'junction' : 'dir')
    const made = await make(turn.prepared.authority, { description: 'A fox' })
    expect(made).toMatchObject({ isError: true, text: expect.stringMatching(/couldn't be saved in your files folder/) })
    expect(readdirSync(outside, { recursive: true })).toEqual([])
    rmSync(join(files, 'images'), { recursive: true, force: true })
  })

  it('Runs on offers the entries\' image models, saves a pick with the entry\'s sign-in, and None takes it away', async () => {
    const service = new BotChatService(f.bots, { store: f.store, now: () => f.clock.now, images: { options: () => images.options(), usage: (id) => images.usage(id) } })
    const listing = imageProviderOptions([{ id: 'openrouter', instanceId: 'pi:openrouter', label: 'OpenRouter', models: [] }], await images.options())
    expect(listing).toEqual([{ id: 'openrouter', instanceId: 'pi:openrouter', label: 'OpenRouter', models: [{ id: FLASH.model, label: 'Gemini 3.1 Flash Image' }, { id: 'openai/gpt-image-2', label: 'GPT Image 2' }] }])
    await service.modelImageSet(botId, FLASH)
    expect(f.bots.imagePick(botId)).toEqual({ ...FLASH, credential: 'api_key' })
    await expect(service.modelImageSet(botId, { instanceId: 'claude', model: 'sonnet' })).rejects.toMatchObject({ code: 'model_unavailable' })
    expect((await service.modelGet(botId)).image).toEqual(FLASH)
    await service.modelImageSet(botId, null)
    expect(f.bots.imagePick(botId)).toBeNull()
    // The model rows were never touched.
    expect(f.bots.ownerSlots(botId)).toEqual(ROWS)
  })
})

describe('the picture chip', () => {
  it('says it made a picture, counting only the pictures made', () => {
    const call = (ok: boolean) => ({ tool: 'make_image', input: { description: 'x' }, result: { ok } })
    expect(rollUpChips([call(true), call(false), call(true)])).toEqual([{ icon: 'think', text: 'made 2 pictures' }])
    expect(rollUpChips([call(false)])).toEqual([])
  })
})

describe('the Images row as stored', () => {
  const thread = (model: BotThreadSpec['model']): Pick<BotThreadSpec, 'model' | 'slots'> => ({ model })

  it('sits beside the rows, which stay as they are; changing the rows keeps it; None removes it', () => {
    const picked = withSlots(thread({ mode: 'auto', depth: 'normal' }), ROWS)
    const withImage = withImagePick(picked, { ...FLASH, effort: 'high' })
    expect(imagePickOf(withImage)).toEqual(FLASH)
    expect(slotsOf(withImage)).toEqual(ROWS)
    expect(withImage.model).toEqual(picked.model)
    expect(imagePickOf(withSlots(withImage, { ...ROWS, hard: { ...TALK, effort: 'high' } }))).toEqual(FLASH)
    expect(withImagePick(withImage, null)).toEqual(picked)
  })

  it('a bot from before picks keeps Mousse choosing its rows beside an image pick', () => {
    const old = thread({ mode: 'auto', depth: 'deep' })
    const withImage = withImagePick(old, FLASH)
    expect(withImage.model).toEqual({ mode: 'auto', depth: 'deep' })
    expect(imagePickOf(withImage)).toEqual(FLASH)
    expect(withImagePick(withImage, null)).toEqual(old)
  })

  it('an older build ignores the key, and once it rewrites the model the row is dropped with the others', () => {
    const withImage = withImagePick(withSlots(thread({ mode: 'auto', depth: 'normal' }), ROWS), FLASH)
    expect(modelSlotsProblem(withImage.slots)).toBeUndefined()
    expect(imagePickOf({ ...withImage, model: { mode: 'named', model: 'sonnet', depth: 'normal' } })).toBeNull()
  })
})

describe('the image call on Pi', () => {
  const model = (id: string, output: Array<'text' | 'image'> = ['image']) => ({ id, name: id, api: 'openrouter-images', provider: 'openrouter', baseUrl: 'https://x', input: ['text'], cost: { input: 2, output: 12, cacheRead: 0, cacheWrite: 0 }, type: 'image', output })

  it('offers the catalogue\'s image models, never a router that picks another model', () => {
    const models = { getModelsOfType: () => [model('google/gemini-3.1-flash-image', ['image', 'text']), model('openrouter/auto', ['text', 'image'])] } as unknown as PiImageModels
    expect(piImageModels(models, 'openrouter')).toEqual([{ id: 'google/gemini-3.1-flash-image', label: 'google/gemini-3.1-flash-image', price: { input: 2e-6, output: 12e-6 } }])
  })

  it('sends the description and the shape, and returns the first picture', async () => {
    let payload: unknown
    const models = {
      getModelOfType: (_type: string, _provider: string, id: string) => model(id),
      getAuth: async () => ({ apiKey: 'k' }),
      generateImages: async (_model: unknown, context: { input: unknown[] }, options: { onPayload?: (p: unknown) => unknown }) => {
        payload = options.onPayload?.({ model: 'm', messages: context.input })
        return { stopReason: 'stop', output: [{ type: 'text', text: 'Here.' }, { type: 'image', mimeType: 'image/png', data: PNG }], usage: { input: 5, output: 1290, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } }
      }
    } as unknown as PiImageModels
    const image = await runPiImage(models, 'openrouter', { model: 'google/gemini-3.1-flash-image', prompt: 'A fox', shape: 'portrait' }, new AbortController().signal)
    expect(image).toEqual({ mimeType: 'image/png', data: PNG, text: 'Here.', usage: { input: 5, output: 1290, usd: 0.01 } })
    expect(payload).toMatchObject({ image_config: { aspect_ratio: '9:16' }, messages: [{ type: 'text', text: 'A fox' }] })
  })

  it.each([
    ['400: {"error":{"message":"Request blocked by safety filter"}}', 'refused'],
    ['401 Incorrect API key provided', 'signed_out'],
    ['402: {"error":{"message":"Insufficient credits"}}', 'no_credit'],
    ['429 Rate limit exceeded', 'busy'],
    ['Request timed out.', 'no_answer'],
    ['500: internal error', 'failed']
  ])('names a failure by its kind: %s', (text, kind) => {
    expect(failureKind(text)).toBe(kind)
  })
})

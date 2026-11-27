import { BOT_ACCESSORIES, BOT_COLOURS, BOT_EYE_COLOURS, BOT_EYES, BOT_KINDS, botEyeColourOf, botEyesOf, botKindOf, botLookWords, type KnownBotLook } from '../../shared/bots/personal/look'
import type { BotDepth, BotModelPick, BotModelSlots, BotWorkLevel } from '../../shared/bots/personal/definition'
import { pickSourceOf } from '../../shared/bots/personal/modelSlots'
import type { BotDeviceAccess } from '../../shared/bots/personal/deviceAccess'
import type { BotAllowed } from './instructions'

/**
 * A bot's own profile (`get_profile`): what the bot is and holds, read from where it is kept (the published definition,
 * the grant, the model rows, the device choice, the secret store), never a copy. Each area of the profile is one section
 * with its own builder (`BOT_PROFILE_SECTIONS`), so a new detail is a new line or a new section.
 */
export interface BotProfileFacts {
  name: string
  description: string
  look: KnownBotLook
  /** `face.png` in its files folder, by its full path, once Mousse has saved it; absent until then. */
  facePicture?: string
  filesFolder: string
  rows: BotModelSlots
  /** Its standing level: work that names none runs at it. */
  depth: BotDepth
  /** The Images row, or null when the owner picked none. */
  image: BotModelPick | null
  custom: Array<{ name: string; description?: string }>
  /** Undefined where the devices can't be read. */
  devices?: { here: string; access: BotDeviceAccess['mode']; reach: string[] }
  /** The secrets it may use, by name and label: never a value. */
  secrets: Array<{ name: string; label?: string }>
  /** What its grant gives it now, the owner's switches applied; undefined without an approved grant. */
  allowed?: BotAllowed
}

/** A model pick in plain words: its model and entry, and its reasoning level. Null is a row Mousse chooses for. */
export type BotPickName = (pick: BotModelPick | null) => string

interface Section {
  title: string
  lines: string[]
}

type SectionBuilder = (facts: BotProfileFacts, name: BotPickName) => Section

/** The look's fields as `set_profile` takes them, with the values each may have. */
export const BOT_LOOK_FIELDS_TEXT = `kind (${BOT_KINDS.join(', ')}), colour (${BOT_COLOURS.join(', ')}), accessory (${BOT_ACCESSORIES.join(', ')}), eyes (${BOT_EYES.join(', ')}), eyeColour (${BOT_EYE_COLOURS.join(', ')})`

const whoYouAre: SectionBuilder = (facts) => {
  const { look } = facts
  return {
    title: 'Who you are',
    lines: [
      `Name: ${facts.name}`,
      `Description: ${facts.description.trim()}`,
      `Look: ${botLookWords(look)} (kind ${botKindOf(look)}, colour ${look.colour}, accessory ${look.accessory}, eyes ${botEyesOf(look)}, eyeColour ${botEyeColourOf(look)}). set_profile changes it when your owner asks.`,
      facts.facePicture
        ? `Face picture: ${facts.facePicture} (a 512 px PNG of your face, front view, as the app draws it; Mousse draws it again when your look changes). Use it where your owner wants your picture, such as an account's profile picture.`
        : 'Face picture: none saved yet. Mousse saves one as face.png in your files folder the next time the app is open.',
      `Files folder: ${facts.filesFolder}`
    ]
  }
}

const WORK_LEVELS: readonly BotWorkLevel[] = ['light', 'medium', 'hard']

const howYouRun: SectionBuilder = (facts, name) => {
  // A Work row left unpicked runs on the row it borrows from (Medium work's, else Talk's model).
  const work = (level: BotWorkLevel) => name(facts.rows[pickSourceOf(facts.rows, level) ?? level])
  return {
    title: 'How you run',
    lines: [
      `Talking (this chat): ${name(facts.rows.talk)}`,
      `Work: ${WORK_LEVELS.map((level) => `${level} ${work(level)}`).join('; ')}`,
      `Usual level: ${facts.depth} (set_depth changes it)`,
      `Pictures (make_image): ${facts.image ? name(facts.image) : 'none: your owner picked no image model in Runs on'}`,
      ...(facts.custom.length ? [`Custom slots: ${facts.custom.map((slot) => (slot.description ? `${slot.name} (${slot.description})` : slot.name)).join(', ')}`] : []),
      'Your owner changes these in About → Runs on.'
    ]
  }
}

const whatYouCanReach: SectionBuilder = (facts) => {
  const devices = facts.devices
  const reach = !devices
    ? 'unknown now'
    : devices.access === 'all'
      ? 'every one of your owner\'s devices'
      : devices.access === 'this_computer' || !devices.reach.length
        ? 'this computer only'
        : `this computer and ${devices.reach.join(', ')}`
  const mcp = facts.allowed?.off?.mcp ? 'switched off by your owner' : facts.allowed?.mcp?.length ? facts.allowed.mcp.join(', ') : 'none'
  const secrets = facts.secrets.length ? facts.secrets.map((secret) => (secret.label ? `${secret.name} (${secret.label})` : secret.name)).join(', ') : 'none'
  return {
    title: 'What you can reach',
    lines: [
      ...(devices ? [`You run on ${devices.here}.`] : []),
      `Devices your owner reaches you from: ${reach}`,
      `Your owner's MCP servers you use: ${mcp}`,
      `Keys and secrets you were given, by name (you never see their values): ${secrets}`
    ]
  }
}

const whatYouMayDo: SectionBuilder = (facts) => {
  const allowed = facts.allowed
  if (!allowed) return { title: 'What you may do', lines: ['Your owner has not approved your permissions yet.'] }
  const off = allowed.off ?? {}
  const powers: Array<[string, boolean, boolean?]> = [
    ['search the web and read pages', allowed.web],
    ['run commands', allowed.shell, off.shell],
    ['use your own browser', allowed.browser, off.browser],
    ["use your owner's threads", allowed.threads, off.threads],
    ['use apps on this computer', allowed.computer === true, off.computer],
    ["use your owner's skills", !off.skills, off.skills],
    ['make pictures', allowed.images === true],
    ...(allowed.automation.length || off.automation ? [['use the automation tools', allowed.automation.length > 0, off.automation] as [string, boolean, boolean?]] : [])
  ]
  const yes = powers.filter(([, has, isOff]) => has && !isOff).map(([what]) => what)
  const no = powers.filter(([, has, isOff]) => !has && !isOff).map(([what]) => what)
  const switchedOff = powers.filter(([, , isOff]) => isOff).map(([what]) => what)
  return {
    title: 'What you may do',
    lines: [
      `Allowed: ${yes.length ? yes.join(', ') : 'nothing beyond your own tools'}`,
      ...(no.length ? [`Not allowed (ask with permission_ask when your owner wants it): ${no.join(', ')}`] : []),
      ...(switchedOff.length ? [`Switched off by your owner (never ask): ${switchedOff.join(', ')}`] : []),
      'Always yours: your files folder, your memory, your schedules and reminders, and your own tools.'
    ]
  }
}

/** The profile's sections, in order. */
export const BOT_PROFILE_SECTIONS: readonly SectionBuilder[] = [whoYouAre, howYouRun, whatYouCanReach, whatYouMayDo]

/** The whole profile as plain text: each section's title, then its lines. */
export function botProfileText(facts: BotProfileFacts, name: BotPickName): string {
  return BOT_PROFILE_SECTIONS.map((build) => {
    const section = build(facts, name)
    return [section.title, ...section.lines.map((line) => `- ${line}`)].join('\n')
  }).join('\n\n')
}

/**
 * The one line on the bot's look in its system text: its look in a few words, its face picture when saved, and where
 * the rest is. It changes only when the look or the picture does, so a runtime keeps its cache.
 */
export function botIdentityLine(look: KnownBotLook, facePicture?: string): string {
  return `You look like ${botLookWords(look)}.${facePicture ? ` Your face picture is ${facePicture}.` : ''} get_profile has the rest about you.`
}

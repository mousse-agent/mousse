import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { Type, type Tool } from '@earendil-works/pi-ai'
import { APPLET_SOURCE_LIMIT } from '../../../../shared/applets'
import { BOT_APPLET_TOOL } from '../../../../shared/bots/personal/manifest'
import { refused } from './refusal'
import { plainSchema, type MousseTool } from './types'

/** `publish_applet`: stages an offline HTML/CSS/JS applet for the response (SPEC: applets). */
export const PUBLISH_APPLET_TOOL: Tool = {
  name: 'publish_applet',
  description:
    'Publish a complete offline HTML/CSS/JS illustration or interactive dashboard in this thread. This stages presentation until the response completes; never performs workspace or network actions. Give each part inline (html, css, js) or as a file in this thread\'s folder (htmlPath, cssPath, jsPath); when the page is already on disk, prefer the path over retyping it. A part not given is empty.',
  parameters: Type.Object({
    schemaVersion: Type.Literal(1),
    title: Type.String({ maxLength: 120 }),
    description: Type.String({ maxLength: 1000 }),
    html: Type.Optional(Type.String()),
    css: Type.Optional(Type.String()),
    js: Type.Optional(Type.String()),
    htmlPath: Type.Optional(Type.String({ description: 'An HTML file in this thread\'s folder, instead of html.' })),
    cssPath: Type.Optional(Type.String({ description: 'A CSS file in this thread\'s folder, instead of css.' })),
    jsPath: Type.Optional(Type.String({ description: 'A JavaScript file in this thread\'s folder, instead of js.' })),
    data: Type.Optional(Type.Unknown()),
    stateVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    appletId: Type.Optional(Type.String()),
    expectedRevision: Type.Optional(Type.String())
  })
}

const PARTS = ['html', 'css', 'js'] as const

/**
 * The applet's arguments with each part a path names read from the thread's folder (#761), or why a part cannot be:
 * a part given both inline and as a path, a folder the turn has none of, a path outside the folder (a link that leads
 * out included), a file that is not there, or one over the applet source limit. A part given neither way is empty.
 * Arguments that name no path are returned as they are, so an inline call is unchanged.
 */
export function appletFromFiles(args: Record<string, unknown>, folder: string | undefined): { args: Record<string, unknown> } | { refused: string } {
  if (!PARTS.some((part) => args[`${part}Path`] !== undefined)) return { args }
  const out: Record<string, unknown> = { ...args }
  for (const part of PARTS) {
    const key = `${part}Path`
    const given = args[key]
    delete out[key]
    if (given === undefined) {
      if (out[part] === undefined) out[part] = ''
      continue
    }
    if (args[part] !== undefined) return { refused: `Give ${part} or ${key}, not both.` }
    if (typeof given !== 'string' || !given.trim()) return { refused: `${key} must be a file path.` }
    if (!folder) return { refused: `This thread has no folder to read ${key} from; give ${part} inline.` }
    let root: string
    let file: string
    try {
      root = realpathSync.native(folder)
      file = realpathSync.native(resolve(folder, given))
    } catch {
      return { refused: `There is no file at ${key} ${given} in this thread's folder.` }
    }
    const inside = relative(root, file)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return { refused: `${key} ${given} is outside this thread's folder; only its own files can be published.` }
    const stat = statSync(file)
    if (!stat.isFile()) return { refused: `${key} ${given} is not a file.` }
    if (stat.size > APPLET_SOURCE_LIMIT) return { refused: `${key} ${given} is ${Math.ceil(stat.size / 1024)} KiB; an applet's source is at most ${APPLET_SOURCE_LIMIT / 1024} KiB.` }
    out[part] = readFileSync(file, 'utf8')
  }
  return { args: out }
}

/**
 * The turn stages applets (`AppToolTurn.onPublishApplet`): a thread's turns when applets are on, whatever runtime runs
 * them, a subagent's included (its applet shows in its own thread, docs/plans/tool-api.md §1.5). A personal bot's turn publishes as a thread's does when it
 * holds the tool (its main turns, never a consult: `compileBotThread`); its chat shows them (`replyApplets`).
 */
export function appletTools(): MousseTool[] {
  return [{
    name: PUBLISH_APPLET_TOOL.name,
    description: PUBLISH_APPLET_TOOL.description,
    inputSchema: plainSchema(PUBLISH_APPLET_TOOL),
    definition: () => PUBLISH_APPLET_TOOL,
    access: 'actsAsCaller',
    class: 'read',
    listed: (listing) => !listing.botRole || (listing.botRole === 'activation' && Boolean(listing.botTurnTools?.has(BOT_APPLET_TOOL))),
    available: (turn) => (turn.onPublishApplet && (!turn.bot || turn.bot.appTools.has(BOT_APPLET_TOOL)) ? true : 'Applets are off for this turn.'),
    offered: (turn) => Boolean(turn.onPublishApplet) && (!turn.bot || turn.bot.appTools.has(BOT_APPLET_TOOL)),
    describe: (args) => `Publish applet${typeof args.title === 'string' ? ` ${args.title}` : ''}`,
    handler: (args, ctx) => {
      const publish = ctx.turn.onPublishApplet
      if (!publish) throw new Error('Unknown tool: publish_applet')
      const read = appletFromFiles(args, ctx.turn.projectPath)
      if ('refused' in read) return refused('invalid_arguments', read.refused)
      try {
        return { text: JSON.stringify(publish(read.args)) }
      } catch (error) {
        return { text: error instanceof Error ? error.message : 'Invalid applet.', isError: true }
      }
    }
  }]
}

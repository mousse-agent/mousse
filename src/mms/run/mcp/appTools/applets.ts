import { Type, type Tool } from '@earendil-works/pi-ai'
import { plainSchema, type MousseTool } from './types'

/** `publish_applet`: stages an offline HTML/CSS/JS applet for the response (SPEC: applets). */
export const PUBLISH_APPLET_TOOL: Tool = {
  name: 'publish_applet',
  description: 'Publish a complete offline HTML/CSS/JS illustration or interactive dashboard in this thread. This stages presentation until the response completes; never performs workspace or network actions.',
  parameters: Type.Object({
    schemaVersion: Type.Literal(1),
    title: Type.String({ maxLength: 120 }),
    description: Type.String({ maxLength: 1000 }),
    html: Type.String(),
    css: Type.String(),
    js: Type.String(),
    data: Type.Optional(Type.Unknown()),
    stateVersion: Type.Optional(Type.Integer({ minimum: 1 })),
    appletId: Type.Optional(Type.String()),
    expectedRevision: Type.Optional(Type.String())
  })
}

/**
 * The turn stages applets (`AppToolTurn.onPublishApplet`): the main agent's turns when applets are
 * on, whatever runtime runs them. Subagents never publish.
 */
export function appletTools(): MousseTool[] {
  return [{
    name: PUBLISH_APPLET_TOOL.name,
    description: PUBLISH_APPLET_TOOL.description,
    inputSchema: plainSchema(PUBLISH_APPLET_TOOL),
    definition: () => PUBLISH_APPLET_TOOL,
    access: 'actsAsCaller',
    class: 'read',
    available: (turn) => (turn.onPublishApplet && !turn.subagent ? true : 'Applets are off for this turn.'),
    offered: (turn) => Boolean(turn.onPublishApplet) && !turn.subagent,
    describe: (args) => `Publish applet${typeof args.title === 'string' ? ` ${args.title}` : ''}`,
    handler: (args, ctx) => {
      const publish = ctx.turn.onPublishApplet
      if (!publish) throw new Error('Unknown tool: publish_applet')
      try {
        return { text: JSON.stringify(publish(args)) }
      } catch (error) {
        return { text: error instanceof Error ? error.message : 'Invalid applet.', isError: true }
      }
    }
  }]
}

import { COMPOSER_COMMANDS, parseComposerCommand, type ComposerCommandDef } from '../../shared/composerCommands'
import { ipcErrorLine } from './errorText'

/** What the composer has and can do when a command runs. Every action is passed in, so handlers stay testable. */
export interface SlashCommandEnv {
  /** The thread the composer writes to; null on a blank new chat that has no thread yet. */
  threadId: string | null
  /** A turn is running on the thread. */
  turnActive: boolean
  /** Images or files are attached to the message. */
  hasAttachments: boolean
  openUsage(): void
  stop(): Promise<void>
  /** Adds the text to the running turn; false when no turn took it. */
  steer(text: string): Promise<boolean>
  newThread(title?: string): Promise<void>
  clearContext(threadId: string): Promise<void>
  compact(threadId: string, focus?: string): Promise<void>
  fork(threadId: string): Promise<void>
  rename(threadId: string, title: string): Promise<void>
  /** Opens the thread's rename box; false when none is on screen. */
  openRename(threadId: string): boolean
}

/** What the composer does after a command ran. */
export type SlashOutcome =
  /** Handled: empty the composer. */
  | { kind: 'done' }
  /** Nothing to do yet: leave the composer as it is. */
  | { kind: 'keep' }
  /** Not run: keep the text and show this one line. */
  | { kind: 'refused'; message: string }
  /** Send this text as an ordinary message instead. */
  | { kind: 'send'; text: string }

export interface SlashCommand {
  def: ComposerCommandDef
  /**
   * A value this command cannot take (attachments, or text after a command that takes none) is sent
   * as an ordinary message. The others refuse it.
   */
  otherwiseSend?: boolean
  /** Runs with attachments on the message; they stay for the next send. */
  withAttachments?: boolean
  /** Runs while a turn is going; the others refuse. */
  duringTurn?: boolean
  /** Needs a thread that exists. */
  needsThread?: boolean
  run(argument: string, env: SlashCommandEnv): Promise<SlashOutcome> | SlashOutcome
}

const DONE: SlashOutcome = { kind: 'done' }
const refused = (message: string): SlashOutcome => ({ kind: 'refused', message })

function def(name: string): ComposerCommandDef {
  const found = COMPOSER_COMMANDS.find((command) => command.name === name)
  if (!found) throw new Error(`Unknown composer command ${name}`)
  return found
}

/** The commands the composer runs itself, by name. `/skills` opens a picker in the composer and is not here. */
export const SLASH_COMMANDS: ReadonlyMap<string, SlashCommand> = new Map(
  ([
    {
      def: def('usage'),
      otherwiseSend: true,
      duringTurn: true,
      run: (_argument, env) => {
        env.openUsage()
        return DONE
      }
    },
    {
      def: def('stop'),
      withAttachments: true,
      duringTurn: true,
      run: async (_argument, env) => {
        await env.stop()
        return DONE
      }
    },
    {
      def: def('steer'),
      withAttachments: true,
      duringTurn: true,
      run: async (argument, env) => {
        if (!argument) return { kind: 'keep' }
        // No turn took it: it becomes next-turn guidance, an ordinary message.
        return (await env.steer(argument)) ? DONE : { kind: 'send', text: argument }
      }
    },
    {
      def: def('new'),
      otherwiseSend: true,
      duringTurn: true,
      run: async (argument, env) => {
        await env.newThread(argument || undefined)
        return DONE
      }
    },
    {
      def: def('clear'),
      needsThread: true,
      run: async (_argument, env) => {
        await env.clearContext(env.threadId!)
        return DONE
      }
    },
    {
      def: def('compact'),
      needsThread: true,
      run: async (argument, env) => {
        await env.compact(env.threadId!, argument || undefined)
        return DONE
      }
    },
    {
      def: def('fork'),
      needsThread: true,
      run: async (_argument, env) => {
        await env.fork(env.threadId!)
        return DONE
      }
    },
    {
      def: def('rename'),
      needsThread: true,
      // A title changes nothing the turn uses.
      duringTurn: true,
      run: async (argument, env) => {
        if (argument) {
          await env.rename(env.threadId!, argument)
          return DONE
        }
        return env.openRename(env.threadId!) ? DONE : refused('Type a title: /rename <title>')
      }
    }
  ] satisfies SlashCommand[]).map((command) => [command.def.name, command])
)

/**
 * Runs the command a composer value names. Returns null when the value is not one the composer runs,
 * so it is sent as an ordinary message.
 */
export async function runSlashCommand(text: string, env: SlashCommandEnv): Promise<SlashOutcome | null> {
  const parsed = parseComposerCommand(text)
  if (!parsed) return null
  const command = SLASH_COMMANDS.get(parsed.command.name)
  if (!command) return null
  const name = `/${command.def.name}`
  const extraText = command.def.argument === 'none' && parsed.argument !== ''
  const unwantedAttachments = env.hasAttachments && !command.withAttachments
  if (extraText || unwantedAttachments) {
    if (command.otherwiseSend) return null
    return refused(extraText ? `${name} takes no text.` : `Remove the attachments to use ${name}.`)
  }
  if (command.needsThread && !env.threadId) return refused(`Send a message first, then ${name}.`)
  if (env.turnActive && !command.duringTurn) return refused(`Wait for the turn to finish to use ${name}.`)
  try {
    return await command.run(parsed.argument, env)
  } catch (error) {
    return refused(ipcErrorLine(error) || `${name} failed.`)
  }
}

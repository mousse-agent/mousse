import { Type, type Tool } from '@earendil-works/pi-ai'

export type QuickActionKind = 'send-current' | 'send-new-chat' | 'bash'

export interface StagedQuickAction {
  label: string
  kind: QuickActionKind
  payload: string
}

export interface CreatedQuickAction extends StagedQuickAction {
  id: string
  createdAt: string
  updatedAt: string
}

export const QUICK_ACTION_KINDS: QuickActionKind[] = ['send-current', 'send-new-chat', 'bash']

export function describeQuickActionKind(kind: QuickActionKind): string {
  if (kind === 'send-new-chat') return 'new chat + send'
  if (kind === 'bash') return 'terminal command'
  return 'send here'
}

/** Shared with the renderer (`src/renderer/lib/quickActions.ts`) — keep limits in sync. */
export function validateStagedQuickAction(input: Record<string, unknown>): string | undefined {
  const { label, kind, payload } = input
  if (typeof label !== 'string' || !label.trim()) {
    return 'A non-empty label is required.'
  }
  if (label.trim().length > 60) {
    return 'Label must be 60 characters or fewer.'
  }
  if (kind !== 'send-current' && kind !== 'send-new-chat' && kind !== 'bash') {
    return `Kind must be one of: ${QUICK_ACTION_KINDS.join(', ')}.`
  }
  if (typeof payload !== 'string' || !payload.trim()) {
    return kind === 'bash'
      ? 'A shell command is required.'
      : 'The message to send is required.'
  }
  if (payload.length > 4000) {
    return 'Content must be 4000 characters or fewer.'
  }
  return undefined
}

export class QuickActionTools {
  constructor(
    private requestApproval: (
      action: StagedQuickAction,
      threadId: string
    ) => Promise<boolean>,
    private publishCreated: (action: CreatedQuickAction) => void
  ) {}

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'create_quick_action',
        description:
          'Create a reusable quick-action button in the chat header dropdown. ' +
          'Call only when the user asks for a reusable action, shortcut, or button. ' +
          'Creating the action ALWAYS requires the user\u2019s approval, which Mousse requests automatically — ' +
          'never claim the action exists until the tool result confirms it was created. ' +
          'Kinds: send-current (send the message in the current chat), ' +
          'send-new-chat (open a new chat and send the message there), ' +
          'bash (open a new terminal tab and run the shell command).',
        parameters: Type.Object({
          label: Type.String({ description: 'Button label shown in the dropdown (max 60 chars).' }),
          kind: Type.String({
            description: 'One of: send-current, send-new-chat, bash.'
          }),
          payload: Type.String({
            description: 'For send kinds: the chat message. For bash: the shell command.'
          })
        })
      }
    ]
  }

  isQuickActionTool(name: string): boolean {
    return name === 'create_quick_action'
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    threadId?: string
  ): Promise<{ text: string; isError: boolean }> {
    try {
      if (name !== 'create_quick_action') {
        return { text: `Unknown quick-action tool: ${name}`, isError: true }
      }
      const validationError = validateStagedQuickAction(args)
      if (validationError) {
        return { text: validationError, isError: true }
      }
      if (!threadId) {
        return { text: 'Cannot request approval without an active thread.', isError: true }
      }
      const staged: StagedQuickAction = {
        label: String(args.label).trim(),
        kind: args.kind as QuickActionKind,
        payload: String(args.payload)
      }
      let approved = false
      try {
        approved = await this.requestApproval(staged, threadId)
      } catch (err) {
        // Dismissed / timed-out approval resolves as "not created", not a crash.
        const reason = err instanceof Error ? err.message : String(err)
        return { text: `Quick action not created (${reason}).`, isError: false }
      }
      if (!approved) {
        return {
          text: `Quick action "${staged.label}" was not created — the user rejected it.`,
          isError: false
        }
      }
      const timestamp = new Date().toISOString()
      const created: CreatedQuickAction = {
        ...staged,
        id: crypto.randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp
      }
      this.publishCreated(created)
      return {
        text:
          `Quick action created: "${created.label}" (${describeQuickActionKind(created.kind)}). ` +
          `It is now available in the chat header quick-actions dropdown.`,
        isError: false
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { text: message, isError: true }
    }
  }
}

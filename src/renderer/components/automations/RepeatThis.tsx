import { RowMenu } from '../integrations/RowMenu'
import { usePromptThreadId } from '../PromptUndoControls'
import { useAppStore } from '../../stores/appStore'
import { openAutomationCreate } from '../../stores/automationCreateStore'

/**
 * A prompt's menu in a thread: Repeat this… opens Automations with the create row prefilled with the prompt, the
 * thread's project and its model. A bot's thread has none: a bot's schedules are set by asking the bot.
 */
export function RepeatThisMenu({ text }: { text: string }) {
  const threadId = usePromptThreadId()
  const thread = useAppStore((state) => (threadId ? state.threads.find((entry) => entry.id === threadId) : undefined))
  if (!threadId || !thread || thread.botOwned || !text.trim()) return null
  return (
    <span onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
      <RowMenu
        label="Message actions"
        buttonClassName="size-6 flex items-center justify-center rounded-md opacity-50 bg-transparent hover:opacity-100 hover:bg-an-foreground/10"
        iconSize={14}
        items={[{
          label: 'Repeat this…',
          action: 'repeat-this',
          testId: 'message-repeat-this',
          title: 'Run this prompt on a schedule',
          onSelect: () => openAutomationCreate({
            prompt: text.trim(),
            ...(thread.projectId ? { projectId: thread.projectId } : {}),
            ...(thread.modelOverride ? { selection: thread.modelOverride } : {})
          })
        }]}
      />
    </span>
  )
}

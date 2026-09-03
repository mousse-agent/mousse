import { Type, type Tool } from '@earendil-works/pi-ai'
import type { DocumentOpenPayload } from '../../shared/types'

export class PlanModeTools {
  constructor(
    private requestAnswers: (
      questions: Array<{
        id: string
        prompt: string
        options: Array<{ id: string; label: string }>
        allowMultiple?: boolean
      }>,
      threadId: string
    ) => Promise<Record<string, string | string[]>>,
    private openDocument: (payload: DocumentOpenPayload) => void,
    private presentPlan?: (
      payload: { title: string; markdown: string },
      threadId?: string
    ) => void
  ) {}

  getAskUserToolDefinition(): Tool {
    return {
      name: 'ask_user',
      description:
        'Ask the user one or more clarifying questions before continuing. Use when requirements are ambiguous.',
      parameters: Type.Object({
        questions: Type.Array(
          Type.Object({
            id: Type.String({ description: 'Stable question id for the answer map.' }),
            prompt: Type.String({ description: 'Question shown to the user.' }),
            options: Type.Array(
              Type.Object({
                id: Type.String(),
                label: Type.String()
              })
            ),
            allowMultiple: Type.Optional(
              Type.Boolean({ description: 'Allow selecting multiple options.' })
            )
          }),
          { minItems: 1, maxItems: 3 }
        )
      })
    }
  }

  /** Definitions advertised to the model. Preview is a user affordance on the
   * inline plan card — never a model tool call. ask_user clarifies;
   * present_plan lets Agent mode (and Plan mode, optionally) emit the same
   * inline approval card via an explicit tool call — the model decides when
   * presenting a plan beats answering, editing, or delegating. */
  getToolDefinitions(): Tool[] {
    return [this.getAskUserToolDefinition(), this.getPresentPlanToolDefinition()]
  }

  getPresentPlanToolDefinition(): Tool {
    return {
      name: 'present_plan',
      description:
        'Present an implementation plan as an inline approval card with Preview and Approve actions. Use when the user asks for a plan, or when you decide planning ahead beats implementing directly. Pass the full plan markdown; keep response text brief after calling it.',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: 'Short plan title (also used as the original request label).' })),
        markdown: Type.String({ description: 'Full plan markdown: headings, numbered steps, file paths, acceptance criteria.' })
      })
    }
  }

  /** Tools the executor knows how to run, including deprecated aliases kept
   * for in-flight turns. Advertised tools are a subset of this set. */
  getKnownToolNames(): string[] {
    return ['ask_user', 'present_plan', 'show_document']
  }

  isPlanTool(name: string): boolean {
    return this.getKnownToolNames().includes(name)
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    threadId?: string
  ): Promise<{ text: string; isError: boolean }> {
    try {
      if (name === 'ask_user') {
        const questions = parseQuestions(args.questions)
        if (questions.length === 0) {
          return { text: 'No valid questions provided.', isError: true }
        }
        if (!threadId) {
          return { text: 'Cannot ask a question without an active thread.', isError: true }
        }
        const answers = await this.requestAnswers(questions, threadId)
        return { text: JSON.stringify(answers, null, 2), isError: false }
      }

      // Explicit plan presentation: emits the inline approval card from any
      // mode with plan-tool access (notably Agent mode). The model decides
      // when presenting a plan beats answering, editing, or delegating.
      if (name === 'present_plan') {
        const title = String(args.title ?? 'Implementation plan').trim() || 'Implementation plan'
        const markdown = String(args.markdown ?? '')
        if (!markdown.trim()) {
          return { text: 'Plan markdown is empty.', isError: true }
        }
        this.presentPlan?.({ title, markdown }, threadId)
        return { text: `Presented plan "${title}" as an approval card.`, isError: false }
      }

      // Deprecated: no longer advertised to the model (preview is a button on
      // the inline plan card). Kept so in-flight turns that already planned a
      // show_document call still resolve instead of erroring.
      if (name === 'show_document') {
        const title = String(args.title ?? 'Document').trim() || 'Document'
        const markdown = String(args.markdown ?? '')
        if (!markdown.trim()) {
          return { text: 'Document markdown is empty.', isError: true }
        }
        this.openDocument({ title, markdown })
        return { text: `Opened document "${title}" in the preview tab.`, isError: false }
      }

      return { text: `Unknown plan tool: ${name}`, isError: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { text: message, isError: true }
    }
  }
}

function parseQuestions(raw: unknown): Array<{
  id: string
  prompt: string
  options: Array<{ id: string; label: string }>
  allowMultiple?: boolean
}> {
  if (!Array.isArray(raw)) return []

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const id = String(record.id ?? '').trim()
      const prompt = String(record.prompt ?? '').trim()
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              if (!option || typeof option !== 'object') return null
              const opt = option as Record<string, unknown>
              const optId = String(opt.id ?? '').trim()
              const label = String(opt.label ?? '').trim()
              if (!optId || !label) return null
              return { id: optId, label }
            })
            .filter((option): option is { id: string; label: string } => option !== null)
        : []
      if (!id || !prompt || options.length < 2) return null
      return {
        id,
        prompt,
        options,
        allowMultiple: record.allowMultiple === true
      }
    })
    .filter((question): question is NonNullable<typeof question> => question !== null)
}

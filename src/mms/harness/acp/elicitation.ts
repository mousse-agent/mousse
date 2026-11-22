import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { UserQuestion, UserQuestionAnswers, UserQuestionOption } from '../../../shared/types'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import type { AcpRequestScope } from './permissions'

/**
 * ACP form-based elicitation (`elicitation/create` with `mode: 'form'`), mapped to Mousse's thread
 * question widget (`UserQuestionService`).
 *
 * Agents such as Google Antigravity (`agy` 1.5+) send interactive questions as form elicitations
 * once the client advertises `clientCapabilities.elicitation.form: {}`. Choice fields paired with
 * an optional sibling `<key>_other` string field (Antigravity's write-in convention) are folded into
 * the same `UserQuestion` so the widget shows one question per prompt and routes Mousse's built-in
 * "Other…" free-text answer back into `<key>_other`.
 */

type ElicitationValue = string | number | boolean | string[]

interface ParsedField {
  /** Question id handed to `UserQuestionService` (position-based, never collides with JS object keys). */
  questionId: string
  /** Property name in `requestedSchema.properties`. */
  key: string
  /** Optional sibling `<key>_other` plain-string property folded into this question's "Other…" input. */
  otherKey?: string
  kind: 'single' | 'multi' | 'string' | 'boolean' | 'number' | 'integer'
  required: boolean
  /** Map from synthetic option id (`option-0`) to the schema's wire value (`const` or `enum` entry). */
  optionValues: Map<string, string>
  /** Map from exact option label back to wire value, for agents without a paired `_other` field. */
  labelValues: Map<string, string>
  question: UserQuestion
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Extracts choices from titled (`oneOf` / `anyOf` of `{ const, title, description }`) or untitled (`enum`) schemas. */
function extractChoices(source: Record<string, unknown>): Array<{ value: string; label: string }> {
  const titled = Array.isArray(source.oneOf) ? source.oneOf : Array.isArray(source.anyOf) ? source.anyOf : undefined
  if (titled) {
    const out: Array<{ value: string; label: string }> = []
    for (const entry of titled) {
      if (!isRecord(entry) || typeof entry.const !== 'string' || !entry.const.length) continue
      const title = trimmedString(entry.title) || entry.const
      const description = trimmedString(entry.description)
      const label = description && description !== title ? `${title} — ${description}` : title
      out.push({ value: entry.const, label })
    }
    if (out.length) return out
  }
  if (Array.isArray(source.enum)) {
    const out: Array<{ value: string; label: string }> = []
    for (const entry of source.enum) {
      if (typeof entry === 'string' && entry.length) out.push({ value: entry, label: entry })
    }
    if (out.length) return out
  }
  return []
}

function isPlainStringProperty(prop: unknown): boolean {
  if (!isRecord(prop) || prop.type !== 'string') return false
  return extractChoices(prop).length === 0
}

function promptText(prop: Record<string, unknown>, key: string, message: string, singleField: boolean): string {
  const title = trimmedString(prop.title)
  const description = trimmedString(prop.description)
  if (title && description && title !== description) return `${title} — ${description}`
  return title || description || (singleField && message ? message : key)
}

/**
 * Parses an ACP form elicitation's `requestedSchema` into Mousse questions and field decoders.
 * Returns an empty list when the request is not a supported form or declares no usable fields.
 */
export function parseFormElicitation(request: CreateElicitationRequest): ParsedField[] {
  if ((request as { mode?: unknown }).mode !== 'form') return []
  const schema = (request as { requestedSchema?: unknown }).requestedSchema
  if (!isRecord(schema) || !isRecord(schema.properties)) return []
  const properties = schema.properties
  const entries = Object.entries(properties).filter(([key]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
  if (!entries.length) return []

  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : []
  )
  const message = trimmedString((request as { message?: unknown }).message)

  // First pass: detect optional `<key>_other` plain-string companions paired with a choice field.
  const consumedOther = new Set<string>()
  const pairedOther = new Map<string, string>()
  for (const [key, rawProp] of entries) {
    if (!isRecord(rawProp)) continue
    const isChoice =
      (rawProp.type === 'string' && extractChoices(rawProp).length > 0) ||
      (rawProp.type === 'array' && isRecord(rawProp.items) && extractChoices(rawProp.items).length > 0)
    if (!isChoice) continue
    const candidate = `${key}_other`
    if (Object.hasOwn(properties, candidate) && !required.has(candidate) && isPlainStringProperty(properties[candidate])) {
      consumedOther.add(candidate)
      pairedOther.set(key, candidate)
    }
  }

  const visibleEntries = entries.filter(([key]) => !consumedOther.has(key))
  const singleField = visibleEntries.length === 1
  const fields: ParsedField[] = []

  for (const [key, rawProp] of visibleEntries) {
    if (!isRecord(rawProp)) continue
    const questionId = `q${fields.length}`
    const prompt = promptText(rawProp, key, message, singleField)
    const optionValues = new Map<string, string>()
    const labelValues = new Map<string, string>()

    if (rawProp.type === 'string') {
      const choices = extractChoices(rawProp)
      if (choices.length > 0) {
        const options: UserQuestionOption[] = choices.map((choice, index) => {
          const id = `option-${index}`
          optionValues.set(id, choice.value)
          labelValues.set(choice.label, choice.value)
          return { id, label: choice.label }
        })
        const otherKey = pairedOther.get(key)
        fields.push({
          questionId,
          key,
          ...(otherKey ? { otherKey } : {}),
          kind: 'single',
          required: required.has(key),
          optionValues,
          labelValues,
          question: { id: questionId, prompt, options }
        })
      } else {
        fields.push({
          questionId,
          key,
          kind: 'string',
          required: required.has(key),
          optionValues,
          labelValues,
          question: { id: questionId, prompt, options: [] }
        })
      }
      continue
    }

    if (rawProp.type === 'array' && isRecord(rawProp.items)) {
      const choices = extractChoices(rawProp.items)
      if (!choices.length) continue
      const options: UserQuestionOption[] = choices.map((choice, index) => {
        const id = `option-${index}`
        optionValues.set(id, choice.value)
        labelValues.set(choice.label, choice.value)
        return { id, label: choice.label }
      })
      const otherKey = pairedOther.get(key)
      fields.push({
        questionId,
        key,
        ...(otherKey ? { otherKey } : {}),
        kind: 'multi',
        required: required.has(key),
        optionValues,
        labelValues,
        question: { id: questionId, prompt, options, allowMultiple: true }
      })
      continue
    }

    if (rawProp.type === 'boolean') {
      fields.push({
        questionId,
        key,
        kind: 'boolean',
        required: required.has(key),
        optionValues,
        labelValues,
        question: { id: questionId, prompt, options: [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }] }
      })
      continue
    }

    if (rawProp.type === 'number' || rawProp.type === 'integer') {
      fields.push({
        questionId,
        key,
        kind: rawProp.type,
        required: required.has(key),
        optionValues,
        labelValues,
        question: { id: questionId, prompt, options: [] }
      })
    }
  }

  return fields
}

function parseBooleanAnswer(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true' || normalized === 'yes' || normalized === 'y' || normalized === '1') return true
  if (normalized === 'false' || normalized === 'no' || normalized === 'n' || normalized === '0') return false
  return undefined
}

/**
 * Encodes `UserQuestionAnswers` back into an ACP form elicitation `content` map, or `null` when
 * nothing was answered or a required field could not be satisfied.
 */
export function encodeFormElicitationAnswers(fields: readonly ParsedField[], answers: UserQuestionAnswers): Record<string, ElicitationValue> | null {
  const content: Record<string, ElicitationValue> = {}
  const setField = (key: string, value: ElicitationValue) => {
    Object.defineProperty(content, key, { value, enumerable: true, writable: true, configurable: true })
  }

  for (const field of fields) {
    const raw = Object.hasOwn(answers, field.questionId) ? answers[field.questionId] : undefined
    if (field.kind === 'single') {
      const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : ''
      if (field.optionValues.has(value)) {
        setField(field.key, field.optionValues.get(value)!)
      } else {
        const custom = value.trim()
        if (custom) {
          if (field.otherKey) {
            setField(field.otherKey, custom)
          } else {
            const matched = field.labelValues.get(custom) ?? ([...field.optionValues.values()].includes(custom) ? custom : undefined)
            setField(field.key, matched ?? custom)
          }
        }
      }
      continue
    }

    if (field.kind === 'multi') {
      const entries = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map((v) => String(v))
      const selected: string[] = []
      const custom: string[] = []
      for (const entry of entries) {
        if (field.optionValues.has(entry)) {
          selected.push(field.optionValues.get(entry)!)
        } else {
          const text = entry.trim()
          if (!text) continue
          if (field.otherKey) {
            custom.push(text)
          } else {
            const matched = field.labelValues.get(text) ?? ([...field.optionValues.values()].includes(text) ? text : undefined)
            selected.push(matched ?? text)
          }
        }
      }
      if (selected.length) setField(field.key, selected)
      if (custom.length && field.otherKey) setField(field.otherKey, custom.join('\n'))
      continue
    }

    if (field.kind === 'string') {
      const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('\n') : '').trim()
      if (text) setField(field.key, text)
      continue
    }

    if (field.kind === 'boolean') {
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : ''
      const parsed = parseBooleanAnswer(text)
      if (parsed !== undefined) setField(field.key, parsed)
      continue
    }

    if (field.kind === 'number' || field.kind === 'integer') {
      const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '').trim()
      if (!text) continue
      const parsed = Number(text)
      if (Number.isFinite(parsed) && (field.kind === 'number' || Number.isInteger(parsed))) {
        setField(field.key, parsed)
      }
    }
  }

  if (Object.keys(content).length === 0) return null
  for (const field of fields) {
    if (field.required && !Object.hasOwn(content, field.key) && !(field.otherKey && Object.hasOwn(content, field.otherKey))) {
      return null
    }
  }
  return content
}

/**
 * Answers an ACP `elicitation/create` (`mode: 'form'`) request through the thread's question widget.
 * Returns `{ action: 'cancel' }` when the turn cannot ask (`approvals: 'never'`, aborted, no thread)
 * or the user dismisses the card, and `{ action: 'decline' }` when the form has no supported fields.
 */
export async function answerFormElicitation(
  questions: UserQuestionService,
  scope: AcpRequestScope,
  request: CreateElicitationRequest
): Promise<CreateElicitationResponse> {
  if (scope.aborted() || !scope.threadId || scope.approvals === 'never') return { action: 'cancel' }
  const fields = parseFormElicitation(request)
  if (!fields.length) return { action: 'decline' }
  let answers: UserQuestionAnswers
  try {
    answers = await questions.requestAnswers(fields.map((field) => field.question), scope.threadId)
  } catch {
    return { action: 'cancel' }
  }
  if (scope.aborted()) return { action: 'cancel' }
  const content = encodeFormElicitationAnswers(fields, answers)
  return content ? { action: 'accept', content } : { action: 'cancel' }
}

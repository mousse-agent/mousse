export type QuickActionKind = 'send-current' | 'send-new-chat' | 'bash'

export interface QuickAction {
  id: string
  label: string
  kind: QuickActionKind
  payload: string
  isBuiltIn?: boolean
  createdAt: string
  updatedAt: string
}

const STORAGE_KEY = 'mousse.quickActions.v1'

export const QUICK_ACTION_KINDS: QuickActionKind[] = ['send-current', 'send-new-chat', 'bash']

export function quickActionKindLabel(kind: QuickActionKind): string {
  if (kind === 'send-new-chat') return 'New chat + send'
  if (kind === 'bash') return 'Run command'
  return 'Send here'
}

function now(): string {
  return new Date().toISOString()
}

function makeId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `qa-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  }
}

export function createQuickAction(input: {
  label: string
  kind: QuickActionKind
  payload: string
  isBuiltIn?: boolean
}): QuickAction {
  const timestamp = now()
  return {
    id: makeId(),
    label: input.label.trim(),
    kind: input.kind,
    payload: input.payload,
    isBuiltIn: input.isBuiltIn,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export function getDefaultSeed(): QuickAction[] {
  const timestamp = now()
  return [
    {
      id: 'built-in-commit-push',
      label: 'Commit and push',
      kind: 'send-current',
      payload: 'Commit and push your changes feature wise',
      isBuiltIn: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ]
}

function isValidKind(value: unknown): value is QuickActionKind {
  return value === 'send-current' || value === 'send-new-chat' || value === 'bash'
}

/**
 * Validate an action from any source (localStorage, agent-created payloads).
 * Returns null for anything malformed — never throws.
 */
export function sanitizeQuickAction(raw: unknown): QuickAction | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<QuickAction>
  if (typeof candidate.label !== 'string' || !candidate.label.trim()) return null
  if (typeof candidate.payload !== 'string' || !candidate.payload.trim()) return null
  if (!isValidKind(candidate.kind)) return null
  const timestamp = now()
  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : makeId(),
    label: candidate.label.trim().slice(0, 60),
    kind: candidate.kind,
    payload: candidate.payload.slice(0, 4000),
    isBuiltIn: candidate.isBuiltIn === true,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : timestamp,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : timestamp
  }
}

export function loadQuickActions(): QuickAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      const seed = getDefaultSeed()
      saveQuickActions(seed)
      return seed
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      const seed = getDefaultSeed()
      saveQuickActions(seed)
      return seed
    }
    const actions = parsed
      .map(sanitizeQuickAction)
      .filter((action): action is QuickAction => action !== null)
    if (actions.length === 0 && parsed.length > 0) {
      // Storage held only invalid entries — reset to seed rather than empty.
      const seed = getDefaultSeed()
      saveQuickActions(seed)
      return seed
    }
    return actions
  } catch {
    return getDefaultSeed()
  }
}

export function saveQuickActions(actions: QuickAction[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(actions))
  } catch {
    /* ignore quota / private mode */
  }
}

export function validateQuickAction(input: {
  label: string
  kind: unknown
  payload: string
}): string | undefined {
  if (!input.label.trim()) return 'Give the action a name.'
  if (input.label.trim().length > 60) return 'Name must be 60 characters or fewer.'
  if (!isValidKind(input.kind)) return 'Pick an action type.'
  if (!input.payload.trim()) {
    return input.kind === 'bash' ? 'Enter a shell command.' : 'Enter the message to send.'
  }
  if (input.payload.length > 4000) return 'Content must be 4000 characters or fewer.'
  return undefined
}

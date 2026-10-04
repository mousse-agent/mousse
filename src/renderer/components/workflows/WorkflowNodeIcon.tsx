import { Bot, BookOpen, Braces, Clock, FileOutput, GitBranch, GitFork, Globe, Layers, MessageSquare, Play, Repeat, ShieldCheck, Sparkles, Square, StickyNote, Terminal, Workflow, Wrench } from '../../lib/icons'
import { getNodeCatalogEntry } from '../../../shared/workflows'

const categoryIcons = {
  'entry-output': Play, instructions: BookOpen, agents: Bot,
  'deterministic-code': Terminal, functions: Braces, integrations: Wrench,
  skills: Sparkles, browser: Globe, branching: GitBranch, iteration: Repeat,
  parallelism: GitFork, composition: Layers, interaction: MessageSquare,
  timing: Clock, 'files-artifacts': FileOutput, resilience: ShieldCheck, annotation: StickyNote
}

export function WorkflowNodeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const category = getNodeCatalogEntry(type)?.category
  const Icon = type === 'end' ? Square : categoryIcons[category as keyof typeof categoryIcons] ?? Workflow
  return <Icon size={size} aria-hidden="true" />
}

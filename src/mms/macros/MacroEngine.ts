import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { CliType, MacroConfig, MacroStep } from '../../shared/types'
import { appendAgentModelFlag, type AgentTypeId } from '../../shared/settings'
import type { SettingsStore } from '../settings/SettingsStore'
import type { MacroExecutor, MacroProvider, MacroRunContext } from './types'
import { Win32MacroExecutor } from './Win32MacroExecutor'
import { describeSteps } from './types'
import { ClaudeCodeMacroProvider } from './providers/ClaudeCodeMacroProvider'
import { CodexMacroProvider } from './providers/CodexMacroProvider'
import { OpenCodeMacroProvider } from './providers/OpenCodeMacroProvider'
import {
  appendInteractivePermissionFlags,
  mergeHeadlessPermissionArgs
} from './agentPermissionFlags'
import {
  buildHeadlessShellCommand,
  isHeadlessEnabledForAgent,
  resolveHeadlessConfig
} from './headlessCommand'

class JsonMacroProvider implements MacroProvider {
  readonly cliType: CliType
  private config: MacroConfig

  constructor(config: MacroConfig) {
    this.cliType = config.cliType
    this.config = config
  }

  getConfig(): MacroConfig {
    return this.config
  }

  getCliCommand(): string {
    return this.config.cliCommand
  }
}

export class MacroEngine {
  private providers = new Map<CliType, MacroProvider>()
  private executor: MacroExecutor

  constructor(
    macrosDir: string,
    private settingsStore?: SettingsStore,
    executor?: MacroExecutor
  ) {
    this.executor = executor || new Win32MacroExecutor()
    this.registerProvider(new ClaudeCodeMacroProvider(macrosDir))
    this.registerProvider(new CodexMacroProvider(macrosDir))
    this.registerProvider(new OpenCodeMacroProvider(macrosDir))
    this.loadExtraConfigs(macrosDir)
  }

  private isAgentEnabled(cliType: string): boolean {
    if (!this.settingsStore) return true
    const enabled = this.settingsStore.get().agents.enabled
    return enabled[cliType as AgentTypeId] ?? true
  }

  private registerProvider(provider: MacroProvider): void {
    this.providers.set(provider.cliType as CliType, provider)
    console.log(
      `[MacroEngine] Registered ${provider.cliType}: ${describeSteps(provider.getConfig().steps)}`
    )
  }

  private loadExtraConfigs(macrosDir: string): void {
    try {
      const files = readdirSync(macrosDir).filter((f) => f.endsWith('.json'))
      for (const file of files) {
        const raw = readFileSync(join(macrosDir, file), 'utf-8')
        const config = JSON.parse(raw) as MacroConfig
        if (this.providers.has(config.cliType)) continue
        const provider = new JsonMacroProvider(config)
        this.registerProvider(provider)
      }
    } catch (err) {
      console.error('[MacroEngine] Failed to load macro configs:', err)
    }
  }

  getProvider(cliType: CliType): MacroProvider | undefined {
    if (!this.isAgentEnabled(cliType)) return undefined
    return this.providers.get(cliType)
  }

  getCliCommand(cliType: CliType): string {
    if (!this.isAgentEnabled(cliType)) {
      throw new Error(`Agent type "${cliType}" is disabled in settings`)
    }
    const base = this.providers.get(cliType)?.getCliCommand() || cliType
    const model = this.settingsStore?.get().agents.model[cliType as AgentTypeId] ?? ''
    const withPermissions = appendInteractivePermissionFlags(base, cliType)
    return appendAgentModelFlag(withPermissions, cliType as AgentTypeId, model)
  }

  isHeadlessEnabled(cliType: CliType): boolean {
    if (cliType === 'mousse') return false
    if (!this.isAgentEnabled(cliType)) return false
    const headless = this.settingsStore?.get().agents.headless
    return isHeadlessEnabledForAgent(cliType as AgentTypeId, headless)
  }

  getHeadlessShellCommand(cliType: CliType, prompt: string): string {
    if (!this.isAgentEnabled(cliType)) {
      throw new Error(`Agent type "${cliType}" is disabled in settings`)
    }
    const provider = this.providers.get(cliType)
    if (!provider) {
      throw new Error(`No provider for ${cliType}`)
    }
    const config = provider.getConfig()
    const headless = resolveHeadlessConfig(cliType, config.headless)
    const model = this.settingsStore?.get().agents.model[cliType as AgentTypeId] ?? ''
    return buildHeadlessShellCommand(cliType, prompt, headless, model)
  }

  async runMacro(
    cliType: CliType,
    context: MacroRunContext
  ): Promise<{ success: boolean; log: string[] }> {
    if (!this.isAgentEnabled(cliType)) {
      return {
        success: false,
        log: [`[macro] Agent type "${cliType}" is disabled in settings`]
      }
    }
    const provider = this.providers.get(cliType)
    if (!provider) {
      return { success: false, log: [`[macro] No provider for ${cliType}`] }
    }
    return this.executor.execute(provider.getConfig(), context)
  }

  async runPtyMacro(
    cliType: CliType,
    context: MacroRunContext,
    write: (data: string) => void | Promise<void>
  ): Promise<{ success: boolean; log: string[] }> {
    if (!this.isAgentEnabled(cliType)) {
      return {
        success: false,
        log: [`[macro] Agent type "${cliType}" is disabled in settings`]
      }
    }

    const provider = this.providers.get(cliType)
    if (!provider) {
      return { success: false, log: [`[macro] No provider for ${cliType}`] }
    }

    const config = provider.getConfig()
    const log: string[] = [
      `[macro] Running ${config.name} macro against target terminal (${config.steps.length} steps)`
    ]

    for (const step of config.steps) {
      await this.executePtyStep(step, context, write, log)
    }

    log.push('[macro] PTY-scoped execution completed')
    return { success: true, log }
  }

  listProviders(): CliType[] {
    const cliProviders = Array.from(this.providers.keys()).filter((cliType) =>
      this.isAgentEnabled(cliType)
    )
    if (this.isAgentEnabled('mousse')) {
      return ['mousse', ...cliProviders]
    }
    return cliProviders
  }

  private async executePtyStep(
    step: MacroStep,
    context: MacroRunContext,
    write: (data: string) => void | Promise<void>,
    log: string[]
  ): Promise<void> {
    switch (step.type) {
      case 'delay':
        log.push(`[macro] delay ${step.ms ?? 300}ms`)
        await sleep(step.ms ?? 300)
        return
      case 'click':
        log.push(
          `[macro] skipped unscoped click (${step.x}, ${step.y}); prompt delivery is locked to the target terminal`
        )
        return
      case 'paste': {
        const text = step.usePrompt ? context.prompt : step.text ?? ''
        if (!text) {
          log.push('[macro] skipped empty paste')
          return
        }
        await write(text)
        log.push(step.usePrompt ? '[macro] wrote prompt to target terminal' : '[macro] wrote paste text')
        return
      }
      case 'type': {
        const text = step.text ?? ''
        if (!text) {
          log.push('[macro] skipped empty type')
          return
        }
        await write(text)
        log.push('[macro] typed text into target terminal')
        return
      }
      case 'key': {
        const sequence = keyToPtySequence(step.key || 'Enter')
        if (!sequence) {
          log.push(`[macro] skipped unsupported key ${step.key}`)
          return
        }
        await write(sequence)
        log.push(`[macro] key ${step.key}`)
        return
      }
      default:
        log.push(`[macro] skipped unknown step ${(step as MacroStep).type}`)
    }
  }
}

function keyToPtySequence(key: string): string | null {
  const map: Record<string, string> = {
    Enter: '\r',
    Tab: '\t',
    Escape: '\x1b',
    '^l': '\x0c'
  }
  return map[key] ?? null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

import { readFileSync } from 'fs'
import { join } from 'path'
import type { MacroConfig } from '../../../shared/types'
import type { MacroProvider } from '../types'

export class CodexMacroProvider implements MacroProvider {
  readonly cliType = 'codex' as const
  private config: MacroConfig

  constructor(macrosDir: string) {
    this.config = JSON.parse(readFileSync(join(macrosDir, 'codex.json'), 'utf-8')) as MacroConfig
  }

  getConfig(): MacroConfig {
    return this.config
  }

  getCliCommand(): string {
    return this.config.cliCommand
  }
}
